const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const db = require('../db')
const openaiService = require('../services/openai')

// Map frontend voice_model values to Twilio Polly voices
const VOICE_MAP = {
  'nova': 'Polly.Mia',       // Mujer Natural (español MX)
  'shimmer': 'Polly.Lucia',   // Mujer Profesional (español ES)
  'echo': 'Polly.Andres',     // Hombre Natural
  'onyx': 'Polly.Enrique',    // Hombre Profesional
  'alloy': 'Polly.Lupe',      // Neutral
}

// Map frontend language values to Twilio language codes
const LANG_MAP = {
  'es-MX': 'es-MX',
  'es-ES': 'es-ES',
  'en-US': 'en-US',
  'pt-BR': 'pt-BR',
}

function getTwilioVoice(voiceModel) {
  return VOICE_MAP[voiceModel] || 'Polly.Mia'
}

function getTwilioLang(language) {
  return LANG_MAP[language] || 'es-MX'
}

/**
 * Inbound call webhook - Twilio calls this when someone calls the bot's number
 * POST /api/twilio/voice - uses the currently active bot
 * POST /api/twilio/voice/:botId - uses a specific bot (legacy)
 */
router.post('/voice/:botId?', async (req, res) => {
  let bot
  if (req.params.botId) {
    bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(req.params.botId)
  } else {
    bot = db.prepare("SELECT * FROM bots WHERE status = 'active' LIMIT 1").get()
  }
  if (!bot || bot.status !== 'active') {
    res.type('text/xml')
    return res.send(`
      <Response>
        <Say language="es-MX">Lo sentimos, este servicio no está disponible en este momento. Intente más tarde.</Say>
        <Hangup/>
      </Response>
    `)
  }

  const voice = getTwilioVoice(bot.voice_model)
  const lang = getTwilioLang(bot.language)

  // Create call record
  const callId = `call-${crypto.randomUUID()}`
  const callerPhone = req.body.From || 'unknown'
  const callerName = req.body.CallerName || 'Desconocido'

  db.prepare(`
    INSERT INTO calls (id, bot_id, contact_name, contact_phone, type, status, twilio_call_sid)
    VALUES (?, ?, ?, ?, 'inbound', 'in_progress', ?)
  `).run(callId, bot.id, callerName, callerPhone, req.body.CallSid || null)

  // Store system prompt
  db.prepare(`INSERT INTO call_messages (call_id, role, content) VALUES (?, 'system', ?)`).run(callId, bot.system_prompt)
  db.prepare(`INSERT INTO call_messages (call_id, role, content) VALUES (?, 'assistant', ?)`).run(callId, bot.greeting)

  // Respond with greeting and gather speech input
  res.type('text/xml')
  res.send(`
    <Response>
      <Say language="${lang}" voice="${voice}">${escapeXml(bot.greeting)}</Say>
      <Gather input="speech" language="${lang}" speechTimeout="auto" action="/api/twilio/gather/${callId}" method="POST">
        <Say language="${lang}" voice="${voice}">.</Say>
      </Gather>
      <Say language="${lang}" voice="${voice}">No escuché su respuesta. ¿Puedo ayudarle en algo?</Say>
      <Gather input="speech" language="${lang}" speechTimeout="auto" action="/api/twilio/gather/${callId}" method="POST">
        <Say language="${lang}" voice="${voice}">.</Say>
      </Gather>
      <Say language="${lang}" voice="${voice}">Gracias por llamar. ¡Hasta luego!</Say>
      <Hangup/>
    </Response>
  `)
})

/**
 * Outbound call webhook - Twilio calls this when the outbound call connects
 * POST /api/twilio/outbound/:callId
 */
router.post('/outbound/:callId', async (req, res) => {
  const call = db.prepare('SELECT c.*, b.system_prompt, b.greeting, b.voice_model, b.language FROM calls c JOIN bots b ON c.bot_id = b.id WHERE c.id = ?').get(req.params.callId)

  if (!call) {
    res.type('text/xml')
    return res.send(`
      <Response>
        <Say language="es-MX">Lo sentimos, hubo un error. Hasta luego.</Say>
        <Hangup/>
      </Response>
    `)
  }

  const voice = getTwilioVoice(call.voice_model)
  const lang = getTwilioLang(call.language)

  // Store initial messages
  db.prepare(`INSERT INTO call_messages (call_id, role, content) VALUES (?, 'assistant', ?)`).run(call.id, call.greeting)

  res.type('text/xml')
  res.send(`
    <Response>
      <Say language="${lang}" voice="${voice}">${escapeXml(call.greeting)}</Say>
      <Gather input="speech" language="${lang}" speechTimeout="auto" action="/api/twilio/gather/${call.id}" method="POST">
        <Say language="${lang}" voice="${voice}">.</Say>
      </Gather>
      <Say language="${lang}" voice="${voice}">No escuché su respuesta. ¿Sigue ahí?</Say>
      <Gather input="speech" language="${lang}" speechTimeout="auto" action="/api/twilio/gather/${call.id}" method="POST">
        <Say language="${lang}" voice="${voice}">.</Say>
      </Gather>
      <Say language="${lang}" voice="${voice}">Gracias por su tiempo. ¡Hasta luego!</Say>
      <Hangup/>
    </Response>
  `)
})

/**
 * Gather webhook - processes speech input from the caller
 * POST /api/twilio/gather/:callId
 */
router.post('/gather/:callId', async (req, res) => {
  const speechResult = req.body.SpeechResult

  // Get call + bot info (need voice_model and language for TTS)
  const call = db.prepare('SELECT c.*, b.system_prompt, b.llm_model, b.voice_model, b.language FROM calls c JOIN bots b ON c.bot_id = b.id WHERE c.id = ?').get(req.params.callId)
  const voice = call ? getTwilioVoice(call.voice_model) : 'Polly.Mia'
  const lang = call ? getTwilioLang(call.language) : 'es-MX'

  if (!speechResult) {
    res.type('text/xml')
    return res.send(`
      <Response>
        <Say language="${lang}" voice="${voice}">No pude escuchar lo que dijo. ¿Podría repetirlo?</Say>
        <Gather input="speech" language="${lang}" speechTimeout="auto" action="/api/twilio/gather/${req.params.callId}" method="POST">
          <Say language="${lang}" voice="${voice}">.</Say>
        </Gather>
        <Say language="${lang}" voice="${voice}">Gracias por llamar. ¡Hasta luego!</Say>
        <Hangup/>
      </Response>
    `)
  }
  if (!call) {
    res.type('text/xml')
    return res.send(`<Response><Hangup/></Response>`)
  }

  // Store user message
  db.prepare(`INSERT INTO call_messages (call_id, role, content) VALUES (?, 'user', ?)`).run(call.id, speechResult)

  // Get conversation history
  const messages = db.prepare('SELECT role, content FROM call_messages WHERE call_id = ? AND role != ? ORDER BY created_at').all(call.id, 'system')

  // Check for goodbye/end keywords
  const lowerSpeech = speechResult.toLowerCase()
  const endKeywords = ['adiós', 'adios', 'hasta luego', 'bye', 'no gracias', 'eso es todo', 'nada más', 'nada mas', 'colgar']
  const isEnding = endKeywords.some(kw => lowerSpeech.includes(kw))

  try {
    // Generate AI response
    const aiResponse = await openaiService.chat(
      call.system_prompt + (isEnding ? '\nEl usuario quiere terminar la conversación. Despídete amablemente y brevemente.' : ''),
      messages,
      call.llm_model || 'gpt-4o'
    )

    // Store assistant response
    db.prepare(`INSERT INTO call_messages (call_id, role, content) VALUES (?, 'assistant', ?)`).run(call.id, aiResponse)

    if (isEnding) {
      // End the call
      db.prepare("UPDATE calls SET status = 'completed', ended_at = datetime('now') WHERE id = ?").run(call.id)

      // Analyze sentiment
      const allMessages = db.prepare('SELECT role, content FROM call_messages WHERE call_id = ? AND role != ? ORDER BY created_at').all(call.id, 'system')
      const transcript = allMessages.map(m => `${m.role}: ${m.content}`).join('\n')
      const sentiment = await openaiService.analyzeSentiment(transcript)
      const duration = Math.round((Date.now() - new Date(call.started_at).getTime()) / 1000)

      db.prepare('UPDATE calls SET sentiment = ?, duration = ?, transcript = ? WHERE id = ?').run(sentiment, duration, transcript, call.id)

      res.type('text/xml')
      return res.send(`
        <Response>
          <Say language="${lang}" voice="${voice}">${escapeXml(aiResponse)}</Say>
          <Hangup/>
        </Response>
      `)
    }

    // Continue conversation
    res.type('text/xml')
    res.send(`
      <Response>
        <Say language="${lang}" voice="${voice}">${escapeXml(aiResponse)}</Say>
        <Gather input="speech" language="${lang}" speechTimeout="auto" action="/api/twilio/gather/${call.id}" method="POST">
          <Say language="${lang}" voice="${voice}">.</Say>
        </Gather>
        <Say language="${lang}" voice="${voice}">¿Hay algo más en lo que pueda ayudarle?</Say>
        <Gather input="speech" language="${lang}" speechTimeout="auto" action="/api/twilio/gather/${call.id}" method="POST">
          <Say language="${lang}" voice="${voice}">.</Say>
        </Gather>
        <Say language="${lang}" voice="${voice}">Gracias por llamar. ¡Hasta luego!</Say>
        <Hangup/>
      </Response>
    `)
  } catch (err) {
    console.error('AI response error:', err.message)
    res.type('text/xml')
    res.send(`
      <Response>
        <Say language="${lang}" voice="${voice}">Disculpe, tuve un problema procesando su solicitud. ¿Podría repetirlo?</Say>
        <Gather input="speech" language="${lang}" speechTimeout="auto" action="/api/twilio/gather/${req.params.callId}" method="POST">
          <Say language="${lang}" voice="${voice}">.</Say>
        </Gather>
        <Hangup/>
      </Response>
    `)  
  }
})

/**
 * Call status callback
 * POST /api/twilio/status/:callId
 */
router.post('/status/:callId', async (req, res) => {
  const callStatus = req.body.CallStatus
  const duration = parseInt(req.body.CallDuration || '0')

  let status = 'completed'
  if (callStatus === 'failed' || callStatus === 'busy' || callStatus === 'no-answer') {
    status = 'failed'
  }

  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.callId)
  if (call && call.status === 'in_progress') {
    db.prepare("UPDATE calls SET status = ?, duration = ?, ended_at = datetime('now') WHERE id = ?").run(status, duration, req.params.callId)

    // Analyze sentiment if completed
    if (status === 'completed') {
      const allMessages = db.prepare('SELECT role, content FROM call_messages WHERE call_id = ? AND role != ? ORDER BY created_at').all(req.params.callId, 'system')
      if (allMessages.length > 0) {
        const transcript = allMessages.map(m => `${m.role}: ${m.content}`).join('\n')
        const sentiment = await openaiService.analyzeSentiment(transcript)
        db.prepare('UPDATE calls SET sentiment = ?, transcript = ? WHERE id = ?').run(sentiment, transcript, req.params.callId)
      }
    }
  }

  res.sendStatus(200)
})

/**
 * Get available Twilio phone numbers
 * GET /api/twilio/numbers
 */
router.get('/numbers', async (req, res) => {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    return res.status(503).json({ error: 'Twilio not configured' })
  }

  try {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    const numbers = await twilio.incomingPhoneNumbers.list()
    res.json(numbers.map(n => ({
      sid: n.sid,
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName,
      voiceUrl: n.voiceUrl,
    })))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

module.exports = router
