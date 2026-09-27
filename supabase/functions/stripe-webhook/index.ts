// supabase/functions/stripe-webhook/index.ts
import Stripe from 'https://esm.sh/stripe@14?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
});

const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

Deno.serve(async (req) => {
  const signature = req.headers.get('stripe-signature');
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature!, webhookSecret);
  } catch (err) {
    return new Response(`Webhook signature verification failed: ${err.message}`, { status: 400 });
  }

  // Only care about invoice lifecycle events for now
  if (!event.type.startsWith('invoice.')) {
    return new Response(JSON.stringify({ received: true, skipped: event.type }), { status: 200 });
  }

  const invoice = event.data.object as Stripe.Invoice;
  const stripeCustomerId = invoice.customer as string;

  // Match the invoice back to a client via their stored stripe_customer_id
  const { data: client, error: clientErr } = await supabaseAdmin
    .from('clients')
    .select('id')
    .eq('stripe_customer_id', stripeCustomerId)
    .single();

  if (clientErr || !client) {
    console.error(`No client matched to Stripe customer ${stripeCustomerId}`);
    // Still return 200 — Stripe will retry on non-2xx, and this isn't a transient error
    return new Response(JSON.stringify({ received: true, matched: false }), { status: 200 });
  }

  const { error: upsertErr } = await supabaseAdmin.from('payments').upsert({
    client_id: client.id,
    stripe_invoice_id: invoice.id,
    stripe_subscription_id: (invoice.subscription as string) || null,
    amount_due: invoice.amount_due / 100,
    amount_paid: invoice.amount_paid / 100,
    currency: invoice.currency,
    status: invoice.status,
    period_start: invoice.period_start ? new Date(invoice.period_start * 1000).toISOString() : null,
    period_end: invoice.period_end ? new Date(invoice.period_end * 1000).toISOString() : null,
    hosted_invoice_url: invoice.hosted_invoice_url,
    invoice_pdf_url: invoice.invoice_pdf,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'stripe_invoice_id' });

  if (upsertErr) {
    console.error('Failed to upsert payment:', upsertErr);
    return new Response(JSON.stringify({ error: upsertErr.message }), { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), { status: 200 });
});