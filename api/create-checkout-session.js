// api/create-checkout-session.js
// Erstellt eine Stripe-Checkout-Session für einen angemeldeten Supabase-Nutzer.
// Die Nutzer-Identität wird serverseitig aus dem Bearer-Token verifiziert –
// niemals einer vom Browser mitgeschickten User-ID vertrauen.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const PREISE = {
  monthly: { price: 'price_1TxuwBLlvjRoDY6vytiFPCip', mode: 'subscription' },
  lifetime: { price: 'price_1Ty4YWLlvjRoDY6vfRLLGjJW', mode: 'payment' },
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    // 1. Nutzer verifizieren
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      res.status(401).json({ error: 'Nicht angemeldet.' });
      return;
    }

    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !userData || !userData.user) {
      res.status(401).json({ error: 'Sitzung ungültig. Bitte erneut anmelden.' });
      return;
    }
    const user = userData.user;

    // 2. Plan validieren
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const plan = body.plan;
    const gewaehlt = PREISE[plan];
    if (!gewaehlt) {
      res.status(400).json({ error: 'Unbekannter Plan.' });
      return;
    }

    // 3. Checkout-Session erstellen, User-ID sicher mitgeben
    const origin = req.headers.origin || `https://${req.headers.host}`;

    const sessionParams = {
      mode: gewaehlt.mode,
      line_items: [{ price: gewaehlt.price, quantity: 1 }],
      client_reference_id: user.id,
      customer_email: user.email,
      metadata: { plan, user_id: user.id },
      success_url: `${origin}/?checkout=success`,
      cancel_url: `${origin}/?checkout=cancel`,
    };

    if (gewaehlt.mode === 'subscription') {
      sessionParams.subscription_data = { metadata: { plan, user_id: user.id } };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Checkout-Fehler:', err);
    res.status(500).json({ error: 'Checkout konnte nicht gestartet werden.' });
  }
};
