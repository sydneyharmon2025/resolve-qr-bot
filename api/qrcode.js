const QRCode = require('qrcode');
const { createCanvas, loadImage } = require('canvas');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const chunks = [];
  await new Promise((resolve, reject) => {
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', resolve);
    req.on('error', reject);
  });

  const rawBody = Buffer.concat(chunks).toString();
  const params = new URLSearchParams(rawBody);
  const text = params.get('text')?.trim();
  const channelId = params.get('channel_id');

  if (!text) {
    return res.json({ response_type: 'ephemeral', text: '👾 Usage: `/qrcode https://example.com`' });
  }

  try { new URL(text); } catch {
    return res.json({ response_type: 'ephemeral', text: '👾 Not a valid URL.' });
  }

  try {
    const SIZE = 500;

    // Generate QR code on canvas
    const canvas = createCanvas(SIZE, SIZE);
    await QRCode.toCanvas(canvas, text, {
      width: SIZE,
      margin: 2,
      errorCorrectionLevel: 'H',
    });

    // Load and draw logo in center
    const logoUrl = process.env.LOGO_URL || 'https://i.imgur.com/wISxMXY.png';
    const logo = await loadImage(logoUrl);
    const ctx = canvas.getContext('2d');
    const logoSize = SIZE * 0.2;
    const logoX = (SIZE - logoSize) / 2;
    const logoY = (SIZE - logoSize) / 2;

    // White background behind logo
    ctx.fillStyle = 'white';
    ctx.fillRect(logoX - 6, logoY - 6, logoSize + 12, logoSize + 12);
    ctx.drawImage(logo, logoX, logoY, logoSize, logoSize);

    const imageBuffer = canvas.toBuffer('image/png');

    // Step 1: Get upload URL
    const getUrlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `filename=qrcode.png&length=${imageBuffer.length}`,
    });

    const urlData = await getUrlRes.json();
    if (!urlData.upload_url) throw new Error(`Get URL failed: ${JSON.stringify(urlData)}`);

    // Step 2: Upload
    await fetch(urlData.upload_url, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: imageBuffer,
    });

    // Step 3: Complete
    const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: [{ id: urlData.file_id, title: `QR Code: ${text}` }],
        channel_id: channelId,
      }),
    });

    const completeData = await completeRes.json();
    if (!completeData.ok) throw new Error(`Complete failed: ${completeData.error}`);

    return res.json({ response_type: 'in_channel', text: `✅ QR code for ${text}` });

  } catch (err) {
    console.error('QR Error:', err.message);
    return res.json({ response_type: 'ephemeral', text: `❌ Error: ${err.message}` });
  }
};
