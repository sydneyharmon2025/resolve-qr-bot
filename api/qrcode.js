const QRCode = require('qrcode');

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
  const responseUrl = params.get('response_url');

  if (!text) {
    return res.json({ response_type: 'ephemeral', text: '👾 Usage: `/qrcode https://example.com`' });
  }

  try { new URL(text); } catch {
    return res.json({ response_type: 'ephemeral', text: '👾 That doesn\'t look like a valid URL.' });
  }

  res.json({ response_type: 'ephemeral', text: '⚡ Generating your QR code...' });

  try {
    // Generate QR as PNG buffer
    const imageBuffer = await QRCode.toBuffer(text, {
      width: 500,
      margin: 2,
      errorCorrectionLevel: 'H',
    });

    // Step 1: Get upload URL from Slack
    const getUrlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
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

    const { upload_url, file_id, error: urlError } = await getUrlRes.json();
    if (!upload_url) throw new Error(`Get URL failed: ${urlError}`);

    // Step 2: Upload file
    await fetch(upload_url, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: imageBuffer,
    });

    // Step 3: Complete upload and post to channel
    const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
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

    const completeData = await completeRes.json();
    if (!completeData.ok) throw new Error(`Complete failed: ${completeData.error}`);

  } catch (err) {
    console.error('QR Error:', err.message);
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', text: `❌ Error: ${err.message}` }),
    });
  }
};
