const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  }
);

async function getRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(
      typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    );
  }

  return Buffer.concat(chunks);
}

function getPeriodEnd(subscription) {
  const timestamp =
    subscription?.items?.data?.[0]?.current_period_end ||
    subscription?.current_period_end;

  return timestamp
    ? new Date(timestamp * 1000).toISOString()
    : null;
}

async function updateProfile(userId, values) {
  if (!userId) {
    throw new Error('Keine Supabase-User-ID vorhanden.');
  }

  const { error } = await supabaseAdmin
    .from('profiles')
    .update(values)
    .eq('user_id', userId);

  if (error) {
    throw error;
  }
}

async function handleCheckoutCompleted(session) {
  const userId = session.metadata?.supabase_user_id;
  const accessType = session.metadata?.access_type;

  if (!userId || !accessType) {
    throw new Error('Checkout-Metadaten fehlen.');
  }

  if (accessType === 'lifetime') {
    await updateProfile(userId, {
      access_type: 'lifetime',
      access_status: 'active',
      stripe_customer_id: session.customer || null,
      stripe_subscription_id: null,
      current_period_end: null
    });

    return;
  }

  if (accessType === 'monthly' && session.subscription) {
    const subscription = await stripe.subscriptions.retrieve(
      session.subscription
    );

    await updateProfile(userId, {
      access_type: 'monthly',
      access_status: 'active',
      stripe_customer_id: session.customer || null,
      stripe_subscription_id: subscription.id,
      current_period_end: getPeriodEnd(subscription)
    });
  }
}

async function handleSubscriptionUpdated(subscription) {
  const userId = subscription.metadata?.supabase_user_id;

  if (!userId) {
    console.log(
      'Subscription ohne Supabase-User-ID:',
      subscription.id
    );
    return;
  }

  const activeStatuses = ['active', 'trialing'];

  await updateProfile(userId, {
    access_type: 'monthly',
    access_status: activeStatuses.includes(subscription.status)
      ? 'active'
      : subscription.status,
    stripe_customer_id: subscription.customer || null,
    stripe_subscription_id: subscription.id,
    current_period_end: getPeriodEnd(subscription)
  });
}

async function handleSubscriptionDeleted(subscription) {
  const userId = subscription.metadata?.supabase_user_id;

  if (!userId) {
    console.log(
      'Gelöschtes Abo ohne Supabase-User-ID:',
      subscription.id
    );
    return;
  }

  await updateProfile(userId, {
    access_type: 'free',
    access_status: 'inactive',
    stripe_customer_id: subscription.customer || null,
    stripe_subscription_id: null,
    current_period_end: null
  });
}

async function handlePaymentFailed(invoice) {
  let subscriptionId =
    invoice.subscription ||
    invoice.parent?.subscription_details?.subscription;

  if (
    subscriptionId &&
    typeof subscriptionId === 'object'
  ) {
    subscriptionId = subscriptionId.id;
  }

  if (!subscriptionId) {
    console.log(
      'Fehlgeschlagene Rechnung ohne Abo:',
      invoice.id
    );
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(
    subscriptionId
  );

  const userId = subscription.metadata?.supabase_user_id;

  if (!userId) {
    console.log(
      'Fehlgeschlagene Zahlung ohne Supabase-User-ID:',
      invoice.id
    );
    return;
  }

  await updateProfile(userId, {
    access_type: 'monthly',
    access_status: 'past_due',
    stripe_customer_id: subscription.customer || null,
    stripe_subscription_id: subscription.id,
    current_period_end: getPeriodEnd(subscription)
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Nur POST-Anfragen sind erlaubt.'
    });
  }

  const signature = req.headers['stripe-signature'];

  if (!signature) {
    return res.status(400).json({
      error: 'Stripe-Signatur fehlt.'
    });
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).json({
      error: 'STRIPE_WEBHOOK_SECRET fehlt.'
    });
  }

  let event;

  try {
    const rawBody = await getRawBody(req);

    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    console.error(
      'Ungültige Webhook-Signatur:',
      error.message
    );

    return res.status(400).json({
      error: `Webhook-Signatur ungültig: ${error.message}`
    });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;

      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;

      default:
        console.log(
          `Nicht verarbeitetes Stripe-Ereignis: ${event.type}`
        );
    }

    return res.status(200).json({
      received: true
    });
  } catch (error) {
    console.error(
      'Fehler bei der Webhook-Verarbeitung:',
      error
    );

    return res.status(500).json({
      error: 'Das Stripe-Ereignis konnte nicht verarbeitet werden.'
    });
  }
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};
