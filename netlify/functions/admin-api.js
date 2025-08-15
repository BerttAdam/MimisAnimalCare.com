// netlify/functions/admin-api.js
import nodemailer from 'nodemailer';

export default async (req) => {
  const json = (code, obj, extra={}) => ({
    statusCode: code,
    headers: {
      'Content-Type':'application/json',
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Headers':'content-type,x-admin-key',
      ...extra
    },
    body: JSON.stringify(obj)
  });
  if (req.httpMethod === 'OPTIONS')
    return json(200, { ok:true }, { 'Access-Control-Allow-Methods':'GET,POST,OPTIONS' });

  // Auth
  const KEY = process.env.ADMIN_KEY || '';
  const gotKey = req.headers['x-admin-key'] || req.headers['X-Admin-Key'];
  if (!KEY || gotKey !== KEY) return json(401, { ok:false, error:'unauthorized' });

  const action = (req.queryStringParameters?.action || '').toLowerCase();

  try {
    if (req.httpMethod === 'GET') {
      if (action === 'poll') return json(200, { ok:true });
      if (action === 'list') return await handleList();
      return json(400, { ok:false, error:'bad_action' });
    }

    if (req.httpMethod === 'POST') {
      const body = JSON.parse(req.body||'{}');
      const a = (body.action||'').toLowerCase();
      if (!['approve','deny','email','cancel'].includes(a)) return json(400, { ok:false, error:'bad_action' });

      if (a === 'approve' || a === 'deny' || a === 'cancel') {
        await recordStatus(body, a);
      }
      await sendCustomerEmailGmail(a, body);

      if (a === 'cancel') {
        // delete submission from Netlify so it no longer appears
        await deleteBookingSubmission(body.id);
      }

      return json(200, { ok:true });
    }

    return json(405, { ok:false, error:'method_not_allowed' });
  } catch(e){
    return json(500, { ok:false, error: e.message || 'server_error' });
  }
};

// === List + merge latest statuses ===
async function handleList(){
  const { NETLIFY_ACCESS_TOKEN, SITE_ID } = process.env;
  if (!NETLIFY_ACCESS_TOKEN || !SITE_ID) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok:false, error:'Missing NETLIFY_ACCESS_TOKEN or SITE_ID env vars' })
    };
  }

  const forms = await fetch(`https://api.netlify.com/api/v1/sites/${SITE_ID}/forms`, {
    headers: { Authorization: `Bearer ${NETLIFY_ACCESS_TOKEN}` }
  }).then(r=>r.json());

  const bookingForm = forms.find(f=>f.name==='booking');
  const statusForm  = forms.find(f=>f.name==='booking-status');

  const bookings = bookingForm
    ? await fetch(`https://api.netlify.com/api/v1/forms/${bookingForm.id}/submissions`, {
        headers: { Authorization: `Bearer ${NETLIFY_ACCESS_TOKEN}` }
      }).then(r=>r.json())
    : [];

  const statuses = statusForm
    ? await fetch(`https://api.netlify.com/api/v1/forms/${statusForm.id}/submissions`, {
        headers: { Authorization: `Bearer ${NETLIFY_ACCESS_TOKEN}` }
      }).then(r=>r.json())
    : [];

  const statusMap = new Map();
  statuses.forEach(s=>{
    const f = s?.data || s?.fields || {};
    const id = f.booking_id || f.id || '';
    const status = (f.status||'').toLowerCase();
    if (id) statusMap.set(id, { status, message: f.message||'' , updated_at: s.created_at });
  });

  const items = bookings.map(b=>{
    const f = b?.data || b?.fields || {};
    const merged = statusMap.get(b.id) || {};
    return {
      id: b.id,
      created_at: b.created_at,
      name: f.name||'',
      email: f.email||'',
      phone: f.phone||'',
      service: f.service||'',
      start: f.start||'',
      end: f.end||'',
      fullDay: f.fullDay||'no',
      status: merged.status || f.status || 'pending',
      admin_note: merged.message || ''
    };
  }).sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));

  const res = {
    ok:true,
    total: items.length,
    pending: items.filter(i=> (i.status||'pending').toLowerCase()==='pending').length,
    approved: items.filter(i=> (i.status||'pending').toLowerCase()==='approved').length,
    denied: items.filter(i=> (i.status||'pending').toLowerCase()==='denied').length,
    items
  };
  return {
    statusCode: 200,
    headers: { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' },
    body: JSON.stringify(res)
  };
}

// === Record decisions in "booking-status" so they persist ===
async function recordStatus(body, action){
  const { URL } = process.env;
  const postUrl = (URL || '').trim() || 'https://mimisanimalcare.com/';

  const payload = new URLSearchParams({
    'form-name':'booking-status',
    booking_id: body.id || '',
    status: action === 'approve' ? 'approved' : action === 'deny' ? 'denied' : 'cancelled',
    service: body.service || '',
    start: body.start || '',
    end: body.end || '',
    customer: body.customerName || '',
    message: body.message || ''
  });

  const r = await fetch(postUrl, {
    method: 'POST',
    headers: { 'Content-Type':'application/x-www-form-urlencoded' },
    body: payload.toString()
  });

  if (!r.ok) throw new Error('Failed to record status');
}

// === Remove a booking submission entirely (after cancellation) ===
async function deleteBookingSubmission(submissionId){
  const { NETLIFY_ACCESS_TOKEN } = process.env;
  if (!NETLIFY_ACCESS_TOKEN) throw new Error('Missing NETLIFY_ACCESS_TOKEN');
  if (!submissionId) throw new Error('Missing submission id');
  const r = await fetch(`https://api.netlify.com/api/v1/submissions/${submissionId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${NETLIFY_ACCESS_TOKEN}` }
  });
  if (!r.ok) throw new Error('Failed to delete submission');
}

// === Gmail sender (nodemailer) ===
async function sendCustomerEmailGmail(action, body){
  const { GMAIL_USER, GMAIL_APP_PASSWORD, FROM_NAME, OWNER_EMAIL } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) throw new Error('Missing GMAIL_USER or GMAIL_APP_PASSWORD');

  const to = (body.customerEmail||'').trim();
  if (!to) throw new Error('No customerEmail provided');

  // Subject/body
  let statusLine = 'Update';
  if(action==='approve') statusLine = 'Approved ✅';
  if(action==='deny') statusLine = 'Declined';
  if(action==='cancel') statusLine = 'Cancelled';

  const subject = `${FROM_NAME || "Mimi's Animal Care"} — ${statusLine}: ${body.service||''}`;
  const lines = [];
  lines.push(`Hi ${body.customerName||'there'},`);
  if (action==='approve') lines.push(`Good news — your request is approved!`);
  else if (action==='deny') lines.push(`Thanks for your request. Unfortunately I’m not available for that time.`);
  else if (action==='cancel') lines.push(`Your booking has been cancelled per request.`);
  else lines.push(`Here’s an update on your request:`);

  lines.push('');
  lines.push(`Service: ${body.service||''}`);
  lines.push(`When: ${body.start||''} → ${body.end||''}`);
  if ((body.message||'').trim()) { lines.push(''); lines.push(`Note from Mimi: ${body.message.trim()}`); }
  lines.push('');
  lines.push(`Reply to this email if you have any questions.`);
  lines.push(`— Mimi`);
  const text = lines.join('\n');

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
  });

  await transporter.sendMail({
    from: `"${FROM_NAME || "Mimi's Animal Care"}" <${GMAIL_USER}>`,
    to,
    cc: OWNER_EMAIL ? [OWNER_EMAIL] : [],
    subject,
    text
  });
}
