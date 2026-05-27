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

  if (!text) {
    return res.json({ response_type: 'ephemeral', text: '👾 Usage: `/qrcode https://example.com`' });
  }

  try { new URL(text); } catch {
    return res.json({ response_type: 'ephemeral', text: '👾 Not a valid URL.' });
  }

  try {
    const imageBuffer = await QRCode.toBuffer(text, { width: 500, margin: 2 });

    console.log('Buffer length:', imageBuffer.length);
    console.log('Token starts with:', process.env.SLACK_BOT_TOKEN?.substring(0, 10));
    console.log('Channel ID:', channelId);

    const getUrlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filename: 'qrcode.png', length: imageBuffer.length }),
    });

    const urlData = await getUrlRes.json();
    console.log('Slack URL response:', JSON.stringify(urlData));

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
    console.log('Complete response:', JSON.stringify(completeData));

    if (!completeData.ok) throw new Error(`Complete failed: ${completeData.error}`);

    return res.json({ response_type: 'in_channel', text: `✅ QR code for ${text}` });

  } catch (err) {
    console.error('QR Error:', err.message);
    return res.json({ response_type: 'ephemeral', text: `❌ Error: ${err.message}` });
  }
};
