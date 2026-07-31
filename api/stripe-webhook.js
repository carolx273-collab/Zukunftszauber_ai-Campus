// api/stripe-webhook.js
// Empfängt Stripe-Events und schaltet den Zugang in Supabase frei.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

// =========================
// Umgebungsvariablen prüfen
// =========================

const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim();
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY?.trim();

if (!stripeSecretKey) {
  throw new Error('STRIPE_SECRET_KEY fehlt.');
}

if (!stripeWebhookSecret) {
  throw new Error('STRIPE_WEBHOOK_SECRET fehlt.');
}

if (!supabaseUrl) {
  throw new Error('SUPABASE_URL fehlt.');
}

if (!supabaseSecretKey) {
  throw new Error('SUPABASE_SECRET_KEY fehlt.');
}

// =========================
// Stripe und Supabase
// =========================

const stripe = new Stripe(stripeSecretKey);

const supabaseAdmin = createClient(
  supabaseUrl,
  supabaseSecretKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  }
);

// =========================
// Rohdaten des Webhooks lesen
// =========================

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    req.on('error', reject);
  });
}

// =========================
// Ende des Zahlungszeitraums
// =========================

function getCurrentPeriodEnd(subscription) {
  if (!subscription) {
    return null;
  }

  const firstItem =
    subscription.items &&
    subscription.items.data &&
    subscription.items.data[0];

  const timestamp =
    subscription.current_period_end ||
    (firstItem && firstItem.current_period_end);

  if (!timestamp) {
    return null;
  }

  return new Date(timestamp * 1000).toISOString();
}

// =========================
// Profil aktualisieren
// =========================

async function updateProfileByUserId(userId, updateData) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update(updateData)
    .eq('user_id', userId)
    .select('user_id');

  if (error) {
    throw new Error(`Supabase-Profil konnte nicht aktualisiert werden: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new Error(
      `Kein Profil mit user_id ${userId} gefunden. In der Tabelle profiles fehlt möglicherweise die Profilzeile.`
    );
  }

  return data;
}

// =========================
// Webhook
// =========================

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const stripeSignature = req.headers['stripe-signature'];

  if (!stripeSignature) {
    res.status(400).send('Stripe-Signatur fehlt.');
    return;
  }

  let event;

  try {
    const rawBody = await getRawBody(req);

    event = stripe.webhooks.constructEvent(
      rawBody,
      stripeSignature,
      stripeWebhookSecret
    );
  } catch (error) {
    console.error('Webhook-Signatur ungültig:', error.message);

    res.status(400).send(`Webhook Error: ${error.message}`);
    return;
  }

  try {
    switch (event.type) {
      // =====================================
      // Checkout erfolgreich abgeschlossen
      // =====================================

      case 'checkout.session.completed': {
        const session = event.data.object;

        const userId =
          session.client_reference_id ||
          session.metadata?.user_id ||
          session.metadata?.supabase_user_id;

        const plan =
          session.metadata?.plan ||
          session.metadata?.access_type;

        if (!userId) {
          throw new Error(
            `checkout.session.completed ${session.id} enthält keine user_id.`
          );
        }

        if (!plan) {
          throw new Error(
            `checkout.session.completed ${session.id} enthält keinen Plan.`
          );
        }

        if (!['monthly', 'lifetime'].includes(plan)) {
          throw new Error(
            `Unbekannter Plan im Checkout: ${plan}`
          );
        }

        const updateData = {
          access_type: plan,
          access_status: 'active',
          stripe_customer_id: session.customer || null
        };

        // Monatliches Abo
        if (plan === 'monthly' && session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(
            session.subscription
          );

          updateData.stripe_subscription_id = session.subscription;
          updateData.current_period_end =
            getCurrentPeriodEnd(subscription);
        }

        // Lifetime-Zugang hat kein Ablaufdatum
        if (plan === 'lifetime') {
          updateData.stripe_subscription_id = null;
          updateData.current_period_end = null;
        }

        await updateProfileByUserId(userId, updateData);

        console.log(
          `Zugang erfolgreich freigeschaltet. User: ${userId}, Plan: ${plan}`
        );

        break;
      }

      // =====================================
      // Abo wurde aktualisiert
      // =====================================

      case 'customer.subscription.updated': {
        const subscription = event.data.object;

        const activeStatuses = ['active', 'trialing'];

        const accessStatus = activeStatuses.includes(subscription.status)
          ? 'active'
          : 'inactive';

        const updateData = {
          access_status: accessStatus,
          current_period_end: getCurrentPeriodEnd(subscription)
        };

        const { data, error } = await supabaseAdmin
          .from('profiles')
          .update(updateData)
          .eq('stripe_subscription_id', subscription.id)
          .select('user_id');

        if (error) {
          throw new Error(
            `Abo-Status konnte nicht aktualisiert werden: ${error.message}`
          );
        }

        if (!data || data.length === 0) {
          console.warn(
            `Kein Profil mit stripe_subscription_id ${subscription.id} gefunden.`
          );
        }

        break;
      }

      // =====================================
      // Abo wurde beendet
      // =====================================

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;

        const { data, error } = await supabaseAdmin
          .from('profiles')
          .update({
            access_status: 'inactive',
            current_period_end: getCurrentPeriodEnd(subscription)
          })
          .eq('stripe_subscription_id', subscription.id)
          .select('user_id');

        if (error) {
          throw new Error(
            `Abo konnte nicht deaktiviert werden: ${error.message}`
          );
        }

        if (!data || data.length === 0) {
          console.warn(
            `Kein Profil mit stripe_subscription_id ${subscription.id} gefunden.`
          );
        }

        break;
      }

      // =====================================
      // Andere Stripe-Events ignorieren
      // =====================================

      default: {
        console.log(`Stripe-Event ignoriert: ${event.type}`);
        break;
      }
    }

    res.status(200).json({
      received: true,
      eventType: event.type
    });
  } catch (error) {
    console.error('Webhook-Verarbeitung fehlgeschlagen:', error);

    res.status(500).json({
      error: 'Webhook konnte nicht verarbeitet werden.',
      message: error.message
    });
  }
};

// Vercel muss den rohen Request-Body erhalten.
// Sonst kann Stripe die Signatur nicht überprüfen.

module.exports.config = {
  api: {
    bodyParser: false
  }
};
