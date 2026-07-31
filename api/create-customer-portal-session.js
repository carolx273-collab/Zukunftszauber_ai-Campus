const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim();
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY?.trim();

if (!stripeSecretKey) {
  throw new Error('STRIPE_SECRET_KEY fehlt.');
}

if (!supabaseUrl) {
  throw new Error('SUPABASE_URL fehlt.');
}

if (!supabaseSecretKey) {
  throw new Error('SUPABASE_SECRET_KEY fehlt.');
}

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({
      error: 'Method Not Allowed'
    });
    return;
  }

  try {
    const authHeader = req.headers.authorization || '';

    const accessToken = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : '';

    if (!accessToken) {
      res.status(401).json({
        error: 'Nicht angemeldet.'
      });
      return;
    }

    const {
      data: userData,
      error: userError
    } = await supabaseAdmin.auth.getUser(accessToken);

    if (userError || !userData?.user) {
      res.status(401).json({
        error: 'Sitzung ungültig. Bitte erneut anmelden.'
      });
      return;
    }

    const user = userData.user;

    const {
      data: profile,
      error: profileError
    } = await supabaseAdmin
      .from('profiles')
      .select('stripe_customer_id, access_type, role')
      .eq('user_id', user.id)
      .single();

    if (profileError || !profile) {
      res.status(404).json({
        error: 'Profil wurde nicht gefunden.'
      });
      return;
    }

    if (!profile.stripe_customer_id) {
      res.status(400).json({
        error: 'Für dieses Konto wurde kein Stripe-Kunde gefunden.'
      });
      return;
    }

    const origin =
      req.headers.origin ||
      `https://${req.headers.host}`;

    const portalSession =
      await stripe.billingPortal.sessions.create({
        customer: profile.stripe_customer_id,
        return_url: `${origin}/`
      });

    res.status(200).json({
      url: portalSession.url
    });
  } catch (error) {
    console.error(
      'Fehler beim Erstellen des Kundenportals:',
      error
    );

    res.status(500).json({
      error: 'Das Kundenportal konnte nicht geöffnet werden.'
    });
  }
};
