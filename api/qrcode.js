const QRCode = require('qrcode');
const Jimp = require('jimp');

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

    // Generate QR code as buffer
    const qrBuffer = await QRCode.toBuffer(text, {
      width: SIZE,
      margin: 2,
      errorCorrectionLevel: 'H',
    });

    // Load QR and logo with Jimp
    const qrImage = await Jimp.read(qrBuffer);
    const logoUrl = process.env.LOGO_URL || 'https://i.imgur.com/wISxMXY.png';
    const logoResponse = await fetch(logoUrl);
    const logoBuffer = Buffer.from(await logoResponse.arrayBuffer());
    const logoImage = await Jimp.read(logoBuffer);

    // Resize logo to 20% of QR size
    const logoSize = Math.floor(SIZE * 0.2);
    logoImage.resize(logoSize, logoSize);

    // Add white background behind logo
    const whiteBg = new Jimp(logoSize + 20, logoSize + 20, 0xffffffff);
    whiteBg.composite(logoImage, 10, 10);

    // Center composite on QR
    const x = Math.floor((SIZE - whiteBg.getWidth()) / 2);
    const y = Math.floor((SIZE - whiteBg.getHeight()) / 2);
    qrImage.composite(whiteBg, x, y);

    const imageBuffer = await qrImage.getBufferAsync(Jimp.MIME_PNG);

    // Upload to Slack
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

    await fetch(urlData.upload_url, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: imageBuffer,
    });

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
