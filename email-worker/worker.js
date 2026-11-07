// Cloudflare Email Worker for Paperwork: passes every email sent to Paperwork's address on to the app, which
// adds the attachments to the Inbox in Google Drive (see server/email.ts). Set up as Paperwork's Settings > Email
// and DEPLOY.md describe, in Cloudflare's dashboard or with:
//   npx wrangler deploy
//   npx wrangler secret put INBOUND_EMAIL_SECRET     (the same value as in Paperwork's Secret Manager)
// then route the address to this worker under Email > Email Routing in the Cloudflare dashboard.

export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    let res;
    try {
      res = await fetch(`${env.PAPERWORK_URL.replace(/\/+$/, '')}/inbound/email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'message/rfc822',
          Authorization: `Bearer ${env.INBOUND_EMAIL_SECRET}`,
        },
        body: raw,
      });
    } catch {
      message.setReject('Paperwork could not be reached. Please send the email again later.');
      return;
    }
    if (res.status === 403) {
      message.setReject('This address only accepts documents from its owner.');
    } else if (!res.ok) {
      // The sender gets a bounce, so nothing is lost silently
      message.setReject(`Paperwork could not take this email (error ${res.status}). Please send it again later.`);
    }
  },
};
