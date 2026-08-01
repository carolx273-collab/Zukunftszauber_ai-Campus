const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY?.trim();

if (!supabaseUrl || !supabaseSecretKey) {
  throw new Error('Supabase-Umgebungsvariablen fehlen.');
}

const supabaseAdmin = createClient(supabaseUrl, supabaseSecretKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
});

async function requireAdmin(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) throw Object.assign(new Error('Nicht angemeldet.'), { status: 401 });

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    throw Object.assign(new Error('Sitzung ungültig.'), { status: 401 });
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('user_id', userData.user.id)
    .single();

  if (profileError || profile?.role !== 'admin') {
    throw Object.assign(new Error('Nur Administrator:innen dürfen Mitglieder bearbeiten.'), { status: 403 });
  }

  return userData.user;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    const adminUser = await requireAdmin(req);
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { user_id, role, access_status } = body;

    if (!user_id) {
      res.status(400).json({ error: 'user_id fehlt.' });
      return;
    }
    if (!['admin', 'team', 'member'].includes(role)) {
      res.status(400).json({ error: 'Ungültige Rolle.' });
      return;
    }
    if (!['active', 'inactive'].includes(access_status)) {
      res.status(400).json({ error: 'Ungültiger Zugangsstatus.' });
      return;
    }

    if (user_id === adminUser.id && role !== 'admin') {
      res.status(400).json({ error: 'Du kannst dir deine eigene Adminrolle nicht entziehen.' });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update({ role, access_status })
      .eq('user_id', user_id)
      .select('user_id, role, access_status')
      .single();

    if (error) throw error;
    res.status(200).json({ member: data });
  } catch (error) {
    console.error('Admin-Mitgliedsupdate fehlgeschlagen:', error);
    res.status(error.status || 500).json({ error: error.message || 'Mitglied konnte nicht aktualisiert werden.' });
  }
};
