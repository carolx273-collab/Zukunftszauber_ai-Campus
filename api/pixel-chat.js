// Backend für den Pixel-Chatbot (Zukunftszauber AI Campus)
// ---------------------------------------------------------
// Läuft als Serverless-Funktion, z. B. auf Vercel: Datei einfach unter
// /api/pixel-chat.js in ein Vercel-Projekt legen und deployen.
// Für Netlify oder Cloudflare Workers muss der Handler minimal angepasst
// werden (siehe README-pixel-chat-setup.md) – die Logik bleibt identisch.
//
// WICHTIG: Der API-Key steht NUR hier, als Umgebungsvariable auf dem
// Server – niemals im Frontend-Code (campus.html)!

const SYSTEM_PROMPT = `Du bist Pixel, der freundliche KI-Lernbegleiter des
"Zukunftszauber AI Campus" – einer Lernplattform für KI-Kompetenz, die sich
an Einsteiger:innen, Berufstätige, Verwaltungen und Familien richtet.

Dein Stil:
- Locker-kompetent, ermutigend, ohne Fachchinesisch.
- Kurze, klare Antworten (in der Regel 2-5 Sätze), außer eine ausführlichere
  Erklärung ist erkennbar gewünscht.
- Deutsch, außer explizit anders gefragt.
- Du beantwortest grundsätzlich alle Fragen der Nutzer:innen – nicht nur
  Fragen zu den Kursen. Bei Themen, die direkt mit den Kursen oder KI-Nutzung
  im Alltag/Beruf/in der Verwaltung zu tun haben, darfst du gerne auf
  passende Kursinhalte hinweisen.
- Bei Rechts-, Steuer- oder medizinischen Fragen: hilfreich einordnen, aber
  klarstellen, dass das keine Rechts-/Steuer-/medizinische Beratung ersetzt.`;

const MODEL = 'claude-sonnet-5'; // gute Balance aus Qualität, Tempo & Kosten
                                  // Alternative für geringere Kosten: 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 700;
const MAX_VERLAUF_NACHRICHTEN = 20; // begrenzt Tokenkosten pro Anfrage

// Auf deine echte Domain anpassen, sobald der Campus live ist (statt '*').
const ERLAUBTE_HERKUNFT = '*';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ERLAUBTE_HERKUNFT);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Nur POST erlaubt' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY ist auf dem Server nicht gesetzt.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const messages = Array.isArray(body?.messages) ? body.messages : [];

  if (messages.length === 0) {
    return res.status(400).json({ error: 'Keine Nachricht übermittelt.' });
  }

  // Nur die letzten N Nachrichten mitsenden, um Kosten & Kontextgröße zu begrenzen
  const gekuerzterVerlauf = messages
    .slice(-MAX_VERLAUF_NACHRICHTEN)
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) })); // grobe Längenbegrenzung pro Nachricht

  try {
    const antwort = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: gekuerzterVerlauf
      })
    });

    if (!antwort.ok) {
      const fehlerText = await antwort.text();
      console.error('Anthropic API Fehler:', antwort.status, fehlerText);
      return res.status(502).json({ error: 'KI-Antwort fehlgeschlagen.' });
    }

    const daten = await antwort.json();
    const textBloecke = (daten.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text);
    const reply = textBloecke.join('\n').trim() || 'Entschuldige, dazu ist mir gerade keine Antwort eingefallen.';

    return res.status(200).json({ reply });
  } catch (err) {
    console.error('Serverfehler:', err);
    return res.status(500).json({ error: 'Interner Serverfehler.' });
  }
};
