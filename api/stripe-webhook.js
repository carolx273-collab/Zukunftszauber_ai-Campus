// api/stripe-webhook.js
// Empfängt Stripe-Events und schaltet den Zugang in Supabase frei.
// Braucht den ROHEN Request-Body für die Signaturprüfung – deshalb
// ist der Vercel-Body-Parser hier bewusst deaktiviert (siehe config unten).

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const signatur = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, signatur, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook-Signatur ungültig:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  try {
    switch (event.type) {
      // Zahlung (Abo-Start oder Lifetime-Einmalzahlung) erfolgreich
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.client_reference_id || (session.metadata && session.metadata.supabase_user_id);
        const plan = session.metadata && session.metadata.access_type;
      
        if (!userId || !plan) {
          console.error('checkout.session.completed ohne user_id oder plan', session.id);
          break;
        }

        const update = {
          access_type: plan,
          access_status: 'active',
          stripe_customer_id: session.customer || null,
        };

        if (plan === 'monthly' && session.subscription) {
          update.stripe_subscription_id = session.subscription;
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          update.current_period_end = new Date(sub.current_period_end * 1000).toISOString();
        }

        const { error } = await supabaseAdmin
          .from('profiles')
          .update(update)
          .eq('user_id', userId);

        if (error) console.error('Supabase-Update (checkout.session.completed) fehlgeschlagen:', error.message);
        break;
      }

      // Abo verlängert / Status geändert (z. B. Zahlung fehlgeschlagen)
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const neuerStatus = sub.status === 'active' ? 'active' : 'inactive';

        const { error } = await supabaseAdmin
          .from('profiles')
          .update({
            access_status: neuerStatus,
            current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
          })
          .eq('stripe_subscription_id', sub.id);

        if (error) console.error('Supabase-Update (subscription.updated) fehlgeschlagen:', error.message);
        break;
      }

      // Abo endgültig beendet (nach Kündigung, am Ende der bezahlten Periode)
      case 'customer.subscription.deleted': {
        const sub = event.data.object;

        const { error } = await supabaseAdmin
          .from('profiles')
          .update({ access_status: 'inactive' })
          .eq('stripe_subscription_id', sub.id);

        if (error) console.error('Supabase-Update (subscription.deleted) fehlgeschlagen:', error.message);
        break;
      }

      default:
        // Andere Events ignorieren wir bewusst.
        break;
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook-Verarbeitung fehlgeschlagen:', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
};

module.exports.config = {
  api: {
    bodyParser: false,
  },
};
