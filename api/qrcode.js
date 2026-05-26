import QRCode from 'qrcode';
import sharp from 'sharp';
import crypto from 'crypto';

export const config = {
  api: { bodyParser: false },
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySlackSignature(signingSecret, rawBody, timestamp, signature) {
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
  if (parseInt(timestamp) < fiveMinutesAgo) return false;
  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', signingSecret);
  hmac.update(baseString);
  const computed = `v0=${hmac.digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  } catch {
    return false;
  }
}

async function generateQRWithLogo(text) {
  const QR_SIZE = 500;

  const qrBuffer = await QRCode.toBuffer(text, {
    width: QR_SIZE,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
    errorCorrectionLevel: 'H',
  });

  const logoUrl = process.env.LOGO_URL;
  if (!logoUrl) return qrBuffer;

  const logoResponse = await fetch(logoUrl);
  if (!logoResponse.ok) return qrBuffer;

  const logoArrayBuffer = await logoResponse.arrayBuffer();
  const logoBuffer = Buffer.from(logoArrayBuffer);

  const logoSize = Math.floor(QR_SIZE * 0.2);

  const resizedLogo = await sharp(logoBuffer)
    .resize(logoSize, logoSize, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toBuffer();

  const paddedLogo = await sharp(resizedLogo)
    .extend({
      top: 10, bottom: 10, left: 10, right: 10,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toBuffer();

  const { width: logoW, height: logoH } = await sharp(paddedLogo).metadata();

  return sharp(qrBuffer)
    .composite([{
      input: paddedLogo,
      top: Math.floor((QR_SIZE - logoH) / 2),
      left: Math.floor((QR_SIZE - logoW) / 2),
    }])
    .png()
    .toBuffer();
}

async function uploadToSlack(imageBuffer, channelId, text) {
  const formData = new FormData();
  formData.append('channels', channelId);
  formData.append('filename', 'qrcode.png');
  formData.append('title', `QR Code for: ${text}`);
  formData.append(
    'file',
    new Blob([imageBuffer], { type: 'image/png' }),
    'qrcode.png'
  );

  const response = await fetch('https://slack.com/api/files.upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    body: formData,
  });

  return response.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];

  if (!verifySlackSignature(
    process.env.SLACK_SIGNING_SECRET,
    rawBody.toString(),
    timestamp,
    signature
  )) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const params = new URLSearchParams(rawBody.toString());
  const text = params.get('text')?.trim();
  const channelId = params.get('channel_id');
  const responseUrl = params.get('response_url');

  if (!text) {
    return res.json({
      response_type: 'ephemeral',
      text: '👾 Please provide a URL. Usage: `/qrcode https://example.com`',
    });
  }

  // Validate it looks like a URL
  try { new URL(text); } catch {
    return res.json({
      response_type: 'ephemeral',
      text: '👾 That doesn\'t look like a valid URL. Try `/qrcode https://example.com`',
    });
  }

  // Acknowledge immediately — Slack requires a response within 3 seconds
  res.json({
    response_type: 'ephemeral',
    text: '⚡ Generating your QR code...',
  });

  try {
    const imageBuffer = await generateQRWithLogo(text);
    const result = await uploadToSlack(imageBuffer, channelId, text);

    if (!result.ok) {
      throw new Error(result.error || 'Slack upload failed');
    }
  } catch (err) {
    console.error('QR generation error:', err);
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response_type: 'ephemeral',
        text: '❌ Something went wrong generating your QR code. Please try again.',
      }),
    });
  }
}
