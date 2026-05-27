const QRCode = require('qrcode');
const sharp = require('sharp');
const crypto = require('crypto');

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

  const logoBuffer = Buffer.from(await logoResponse.arrayBuffer());
  const logoSize = Math.floor(QR_SIZE * 0.2);

  const resizedLogo = await sharp(logoBuffer)
    .resize(logoSize, logoSize, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .png()
    .toBuffer();

  const paddedLogo = await sharp(resizedLogo)
    .extend({ top: 10, bottom: 10, left: 10, right: 10, background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .png()
    .toBuffer();

  const { width: logoW, height: logoH } = await sharp(paddedLogo).metadata();

  return sharp(qrBuffer)
    .composite([{ input: paddedLogo, top: Math.floor((QR_SIZE - logoH) / 2), left: Math.floor((QR_SIZE - logoW) / 2) }])
    .png()
    .toBuffer();
}

async function uploadToSlack(imageBuffer, channelId, text) {
  // Step 1: Get upload URL
  const getUrlResponse = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filename: 'qrcode.png',
      length: imageBuffer.length,
    }),
  });

  const { upload_url, file_id } = await getUrlResponse.json();
  if (!upload_url) throw new Error('Failed to get upload URL');

  // Step 2: Upload the file
  await fetch(upload_url, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: imageBuffer,
  });

  // Step 3: Complete the upload and share to channel
  const completeResponse = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: [{ id: file_id, title: `QR Code: ${text}` }],
      channel_id: channelId,
    }),
  });

  return completeResponse.json();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const chunks = [];
  await new Promise((resolve, reject) => {
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', resolve);
    req.on('error', reject);
  });
  const rawBody = Buffer.concat(chunks).toString();

  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];

  // if (!verifySlackSignature(process.env.SLACK_SIGNING_SECRET, rawBody, timestamp, signature)) {
  //   return res.status(401).json({ error: 'Invalid signature' });
  // }

  const params = new URLSearchParams(rawBody);
  const text = params.get('text')?.trim();
  const channelId = params.get('channel_id');
  const responseUrl = params.get('response_url');

  if (!text) {
    return res.json({ response_type: 'ephemeral', text: '👾 Usage: `/qrcode https://example.com`' });
  }

  try { new URL(text); } catch {
    return res.json({ response_type: 'ephemeral', text: '👾 That doesn\'t look like a valid URL.' });
  }

  res.json({ response_type: 'ephemeral', text: '⚡ Generating your QR code...' });

  try {
    const imageBuffer = await generateQRWithLogo(text);
    await uploadToSlack(imageBuffer, channelId, text);
  } catch (err) {
    console.error('QR Error:', err);
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', text: `❌ Error: ${err.message}` }),
    });
  }
};
