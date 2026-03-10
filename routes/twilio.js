const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const { pool } = require('../db')
const openaiService = require('../services/openai')

// Map frontend voice_model values to Twilio Polly voices
const VOICE_MAP = {
  'nova': 'Polly.Mia',       // Mujer Natural (espanol MX)
  'shimmer': 'Polly.Lucia',   // Mujer Profesional (espanol ES)
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
  try {
    let botResult
    if (req.params.botId) {
      botResult = await pool.query('SELECT * FROM bots WHERE id = $1', [req.params.botId])
    } else {
      botResult = await pool.query("SELECT * FROM bots WHERE status = 'active' LIMIT 1")
    }
    const bot = botResult.rows[0]
    if (!bot || bot.status !== 'active') {
      res.type('text/xml')
      return res.send(`
        <Response>
          <Say language="es-MX">Lo sentimos, este servicio no esta disponible en este momento. Intente mas tarde.</Say>
          <Hangup/>
        </Response>
      `)
    }

    const voice = getTwilioVoice(bot.voice_model)
    const lang = getTwilioLang(bot.language)

    // Create call record
    const callId = 'call-' + crypto.randomUUID()
    const callerPhone = req.body.From || 'unknown'
    const callerName = req.body.CallerName || 'Desconocido'

    await pool.query(
      "INSERT INTO calls (id, bot_id, contact_name, contact_phone, type, status, twilio_call_sid) VALUES ($1, $2, $3, $4, 'inbound', 'in_progress', $5)",
      [callId, bot.id, callerName, callerPhone, req.body.CallSid || null]
    )

    // Store system prompt
    await pool.query("INSERT INTO call_messages (call_id, role, content) VALUES ($1, 'system', $2)", [callId, bot.system_prompt])
    await pool.query("INSERT INTO call_messages (call_id, role, content) VALUES ($1, 'assistant', $2)", [callId, bot.greeting])

    // Respond with greeting and gather speech input
    res.type('text/xml')
    res.send(`
      <Response>
        <Say language="${lang}" voice="${voice}">${escapeXml(bot.greeting)}</Say>
        <Gather input="speech" language="${lang}" speechTimeout="auto" action="/api/twilio/gather/${callId}" method="POST">
          <Say language="${lang}" voice="${voice}">.</Say>
        </Gather>
        <Say language="${lang}" voice="${voice}">No escuche su respuesta. Puedo ayudarle en algo?</Say>
        <Gather input="speech" language="${lang}" speechTimeout="auto" action="/api/twilio/gather/${callId}" method="POST">
          <Say language="${lang}" voice="${voice}">.</Say>
        </Gather>
        <Say language="${lang}" voice="${voice}">Gracias por llamar. Hasta luego!</Say>
        <Hangup/>
      </Response>
    `)
  } catch (err) {
    console.error('Voice webhook error:', err.message)
    res.type('text/xml')
    res.send('<Response><Say language="es-MX">Error interno. Intente mas tarde.</Say><Hangup/></Response>')
  }
})

/**
 * Outbound call webhook - Twilio calls this when the outbound call connects
 * POST /api/twilio/outbound/:callId
 */
router.post('/outbound/:callId', async (req, res) => {
  try {
    const result = await pool.query('SELECT c.*, b.system_prompt, b.greeting, b.voice_model, b.language FROM calls c JOIN bots b ON c.bot_id = b.id WHERE c.id = $1', [req.params.callId])
    const call = result.rows[0]

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
    await pool.query("INSERT INTO call_messages (call_id, role, content) VALUES ($1, 'assistant', $2)", [call.id, call.greeting])

    res.type('text/xml')
    res.send(`
      <Response>
        <Say language="${lang}" voice="${voice}">${escapeXml(call.greeting)}</Say>
        <Gather input="speech" language="${lang}" speechTimeout="auto" action="/api/twilio/gather/${call.id}" method="POST">
          <Say language="${lang}" voice="${voice}">.</Say>
        </Gather>
        <Say language="${lang}" voice="${voice}">No escuche su respuesta. Sigue ahi?</Say>
        <Gather input="speech" language="${lang}" speechTimeout="auto" action="/api/twilio/gather/${call.id}" method="POST">
          <Say language="${lang}" voice="${voice}">.</Say>
        </Gather>
        <Say language="${lang}" voice="${voice}">Gracias por su tiempo. Hasta luego!</Say>
        <Hangup/>
      </Response>
    `)
  } catch (err) {
    console.error('Outbound webhook error:', err.message)
    res.type('text/xml')
    res.send('<Response><Say language="es-MX">Error interno. Intente mas tarde.</Say><Hangup/></Response>')
  }
})

/**
 * Gather webhook - processes speech input from the caller
 * POST /api/twilio/gather/:callId
 */
router.post('/gather/:callId', async (req, res) => {
  const speechResult = req.body.SpeechResult

  try {
    // Get call + bot info (need voice_model and language for TTS)
    const result = await pool.query('SELECT c.*, b.system_prompt, b.llm_model, b.voice_model, b.language FROM calls c JOIN bots b ON c.bot_id = b.id WHERE c.id = $1', [req.params.callId])
    const call = result.rows[0]
    const voice = call ? getTwilioVoice(call.voice_model) : 'Polly.Mia'
    const lang = call ? getTwilioLang(call.language) : 'es-MX'

    if (!speechResult) {
      res.type('text/xml')
      return res.send(`
        <Response>
          <Say language="${lang}" voice="${voice}">No pude escuchar lo que dijo. Podria repetirlo?</Say>
          <Gather input="speech" language="${lang}" speechTimeout="auto" action="/api/twilio/gather/${req.params.callId}" method="POST">
            <Say language="${lang}" voice="${voice}">.</Say>
          </Gather>
          <Say language="${lang}" voice="${voice}">Gracias por llamar. Hasta luego!</Say>
          <Hangup/>
        </Response>
      `)
    }
    if (!call) {
      res.type('text/xml')
      return res.send('<Response><Hangup/></Response>')
    }

    // Store user message
    await pool.query("INSERT INTO call_messages (call_id, role, content) VALUES ($1, 'user', $2)", [call.id, speechResult])

    // Get conversation history
    const messagesResult = await pool.query("SELECT role, content FROM call_messages WHERE call_id = $1 AND role != 'system' ORDER BY created_at", [call.id])
    const messages = messagesResult.rows

    // Check for goodbye/end keywords
    const lowerSpeech = speechResult.toLowerCase()
    const endKeywords = ['adios', 'hasta luego', 'bye', 'no gracias', 'eso es todo', 'nada mas', 'colgar']
    const isEnding = endKeywords.some(kw => lowerSpeech.includes(kw))

    // Generate AI response
    const aiResponse = await openaiService.chat(
      call.system_prompt + (isEnding ? '\nEl usuario quiere terminar la conversacion. Despidete amablemente y brevemente.' : ''),
      messages,
      call.llm_model || 'gpt-4o'
    )

    // Store assistant response
    await pool.query("INSERT INTO call_messages (call_id, role, content) VALUES ($1, 'assistant', $2)", [call.id, aiResponse])

    if (isEnding) {
      // End the call
      await pool.query("UPDATE calls SET status = 'completed', ended_at = NOW() WHERE id = $1", [call.id])

      // Analyze sentiment
      const allMsgsResult = await pool.query("SELECT role, content FROM call_messages WHERE call_id = $1 AND role != 'system' ORDER BY created_at", [call.id])
      const transcript = allMsgsResult.rows.map(m => m.role + ': ' + m.content).join('\n')
      const sentiment = await openaiService.analyzeSentiment(transcript)
      const duration = Math.round((Date.now() - new Date(call.started_at).getTime()) / 1000)

      await pool.query('UPDATE calls SET sentiment = $1, duration = $2, transcript = $3 WHERE id = $4', [sentiment, duration, transcript, call.id])

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
        <Say language="${lang}" voice="${voice}">Hay algo mas en lo que pueda ayudarle?</Say>
        <Gather input="speech" language="${lang}" speechTimeout="auto" action="/api/twilio/gather/${call.id}" method="POST">
          <Say language="${lang}" voice="${voice}">.</Say>
        </Gather>
        <Say language="${lang}" voice="${voice}">Gracias por llamar. Hasta luego!</Say>
        <Hangup/>
      </Response>
    `)
  } catch (err) {
    console.error('AI response error:', err.message)
    res.type('text/xml')
    res.send(`
      <Response>
        <Say language="es-MX" voice="Polly.Mia">Disculpe, tuve un problema procesando su solicitud. Podria repetirlo?</Say>
        <Gather input="speech" language="es-MX" speechTimeout="auto" action="/api/twilio/gather/${req.params.callId}" method="POST">
          <Say language="es-MX" voice="Polly.Mia">.</Say>
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
  try {
    const callStatus = req.body.CallStatus
    const duration = parseInt(req.body.CallDuration || '0')

    let status = 'completed'
    if (callStatus === 'failed' || callStatus === 'busy' || callStatus === 'no-answer') {
      status = 'failed'
    }

    const result = await pool.query('SELECT * FROM calls WHERE id = $1', [req.params.callId])
    const call = result.rows[0]
    if (call && call.status === 'in_progress') {
      await pool.query("UPDATE calls SET status = $1, duration = $2, ended_at = NOW() WHERE id = $3", [status, duration, req.params.callId])

      // Analyze sentiment if completed
      if (status === 'completed') {
        const allMsgsResult = await pool.query("SELECT role, content FROM call_messages WHERE call_id = $1 AND role != 'system' ORDER BY created_at", [req.params.callId])
        if (allMsgsResult.rows.length > 0) {
          const transcript = allMsgsResult.rows.map(m => m.role + ': ' + m.content).join('\n')
          const sentiment = await openaiService.analyzeSentiment(transcript)
          await pool.query('UPDATE calls SET sentiment = $1, transcript = $2 WHERE id = $3', [sentiment, transcript, req.params.callId])
        }
      }
    }

    res.sendStatus(200)
  } catch (err) {
    console.error('Status callback error:', err.message)
    res.sendStatus(200)
  }
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
