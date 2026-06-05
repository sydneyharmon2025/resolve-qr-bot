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
    const SIZE = 1080;
    const qrBuffer = await QRCode.toBuffer(text, {
      width: SIZE,
      margin: 2,
      errorCorrectionLevel: 'H',
      color: {
        dark: '#222222',
        light: '#ffffff',
      },
    });

    const qrImage = await Jimp.read(qrBuffer);

    try {
      const logoUrl = process.env.LOGO_URL || 'https://i.imgur.com/wISxMXY.png';
      const logoImage = await Jimp.read(logoUrl);
      const logoSize = Math.floor(SIZE * 0.2);
      logoImage.resize(logoSize, logoSize);
      const whiteBg = new Jimp(logoSize + 20, logoSize + 20, 0xffffffff);
      whiteBg.composite(logoImage, 10, 10);
      const x = Math.floor((SIZE - whiteBg.getWidth()) / 2);
      const y = Math.floor((SIZE - whiteBg.getHeight()) / 2);
      qrImage.composite(whiteBg, x, y);
    } catch (logoErr) {
      console.log('Logo failed, using plain QR:', logoErr.message);
    }

    const imageBuffer = await qrImage.getBufferAsync(Jimp.MIME_PNG);

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
