const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  }
);

const PREISE = {
  monthly: 'price_1TxuwBLlvjRoDY6vytiFPCip',
  lifetime: 'price_1Ty4YWLlvjRoDY6vfRLLGjJW'
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Nur POST-Anfragen sind erlaubt.'
    });
  }

  try {
    const authorization = req.headers.authorization || '';
    const accessToken = authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : null;

    if (!accessToken) {
      return res.status(401).json({
        error: 'Bitte melde dich zuerst im Campus an.'
      });
    }

    const {
      data: { user },
      error: userError
    } = await supabase.auth.getUser(accessToken);

    if (userError || !user) {
      return res.status(401).json({
        error: 'Deine Anmeldung konnte nicht bestätigt werden.'
      });
    }

    const plan = req.body?.plan;

    if (!PREISE[plan]) {
      return res.status(400).json({
        error: 'Ungültiger Campus-Pass.'
      });
    }

    const origin =
      req.headers.origin ||
      'https://campus-zukunftszauberai.de';

    const sessionData = {
      mode: plan === 'monthly' ? 'subscription' : 'payment',

      line_items: [
        {
          price: PREISE[plan],
          quantity: 1
        }
      ],

      customer_email: user.email,

      success_url:
        `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,

      cancel_url:
        `${origin}/?checkout=cancelled`,

      metadata: {
        supabase_user_id: user.id,
        access_type: plan
      },

      allow_promotion_codes: true
    };

    if (plan === 'monthly') {
      sessionData.subscription_data = {
        metadata: {
          supabase_user_id: user.id,
          access_type: 'monthly'
        }
      };
    }

    const session = await stripe.checkout.sessions.create(sessionData);

    return res.status(200).json({
      url: session.url
    });
  } catch (error) {
    console.error('Checkout-Fehler:', error);

    return res.status(500).json({
      error: 'Der Stripe-Checkout konnte nicht gestartet werden.'
    });
  }
};
