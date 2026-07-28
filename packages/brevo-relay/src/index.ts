/**
 * Optional Cloudflare Worker relay for Brevo.
 * Keeps the Brevo API key off the Chrome extension build.
 *
 * Deploy:
 *   cd packages/brevo-relay
 *   npx wrangler login
 *   npx wrangler secret put BREVO_API_KEY
 *   npx wrangler secret put BREVO_SENDER_EMAIL
 *   npx wrangler deploy
 *
 * Then paste the Worker URL into extension Settings → Optional relay URL.
 */

export interface Env {
  BREVO_API_KEY: string;
  BREVO_SENDER_EMAIL: string;
  BREVO_SENDER_NAME?: string;
}

function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    if (!env.BREVO_API_KEY || !env.BREVO_SENDER_EMAIL) {
      return new Response(JSON.stringify({ error: 'Worker secrets not configured' }), {
        status: 500,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    try {
      const payload = await request.json() as {
        to?: string;
        subject?: string;
        html?: string;
        text?: string;
        csv?: string;
        csvName?: string;
      };

      if (!payload.to || !payload.subject || !payload.html) {
        return new Response(JSON.stringify({ error: 'to, subject, and html are required' }), {
          status: 400,
          headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        });
      }

      const body: Record<string, unknown> = {
        sender: {
          name: env.BREVO_SENDER_NAME || 'Job Auto-Apply',
          email: env.BREVO_SENDER_EMAIL,
        },
        to: [{ email: payload.to }],
        subject: payload.subject,
        htmlContent: payload.html,
        textContent: payload.text || undefined,
      };

      if (payload.csv) {
        body.attachment = [{
          name: payload.csvName || 'company-site-apply-report.csv',
          content: toBase64Utf8(payload.csv),
        }];
      }

      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'api-key': env.BREVO_API_KEY,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const text = await res.text();
      return new Response(text || JSON.stringify({ ok: res.ok }), {
        status: res.status,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }), {
        status: 500,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }
  },
};
