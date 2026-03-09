// Only load dotenv in development (Railway provides env vars natively)
try { require('dotenv').config() } catch (e) {}
const express = require('express')
const cors = require('cors')
const crypto = require('crypto')

console.log('ENV CHECK - PORT:', process.env.PORT, 'TWILIO_SID exists:', !!process.env.TWILIO_ACCOUNT_SID, 'OPENAI exists:', !!process.env.OPENAI_API_KEY)

// Catch uncaught errors
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message, err.stack)
})
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err)
})

console.log('Loading database...')
let db
try {
  db = require('./db')
  console.log('Database loaded successfully')
} catch (err) {
  console.error('DATABASE ERROR:', err.message)
}

const twilioRoutes = require('./routes/twilio')
const openaiService = require('./services/openai')

const app = express()
const PORT = process.env.PORT || 3001

// Middleware - allow all origins for cloud deployment
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Root endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Voicebot Commercial API' })
})

// Health check
app.get('/api/health', (req, res) => {
  const twilioConfigured = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  const openaiConfigured = !!process.env.OPENAI_API_KEY
  res.json({
    status: 'ok',
    services: {
      twilio: twilioConfigured ? 'configured' : 'not_configured',
      openai: openaiConfigured ? 'configured' : 'not_configured',
      database: db ? 'connected' : 'error'
    }
  })
})

// ==================== TEMPLATES ====================
app.get('/api/templates', (req, res) => {
  const { category } = req.query
  let templates
  if (category && category !== 'all') {
    templates = db.prepare('SELECT * FROM templates WHERE category = ? ORDER BY is_featured DESC, name').all(category)
  } else {
    templates = db.prepare('SELECT * FROM templates ORDER BY is_featured DESC, name').all()
  }
  templates = templates.map(t => ({ ...t, features: JSON.parse(t.features || '[]') }))
  res.json(templates)
})

app.get('/api/templates/:id', (req, res) => {
  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id)
  if (!template) return res.status(404).json({ error: 'Template not found' })
  template.features = JSON.parse(template.features || '[]')
  res.json(template)
})

// ==================== BOTS ====================
app.get('/api/bots', (req, res) => {
  const { status } = req.query
  let bots
  if (status && status !== 'all') {
    bots = db.prepare('SELECT * FROM bots WHERE status = ? ORDER BY created_at DESC').all(status)
  } else {
    bots = db.prepare('SELECT * FROM bots ORDER BY created_at DESC').all()
  }
  // Add call stats for each bot
  bots = bots.map(bot => {
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total_calls,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_calls,
        AVG(duration) as avg_duration
      FROM calls WHERE bot_id = ? AND date(started_at) = date('now')
    `).get(bot.id)
    return {
      ...bot,
      calls_today: stats.total_calls || 0,
      success_rate: stats.total_calls > 0 ? Math.round((stats.completed_calls / stats.total_calls) * 100) : 0,
      avg_duration: Math.round(stats.avg_duration || 0)
    }
  })
  res.json(bots)
})

app.get('/api/bots/:id', (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(req.params.id)
  if (!bot) return res.status(404).json({ error: 'Bot not found' })
  res.json(bot)
})

app.post('/api/bots', (req, res) => {
  const { name, type, industry, template_id, system_prompt, greeting, voice_style, voice_provider, voice_model, language, phone_number, llm_model, max_duration, transfer_number, status } = req.body

  if (!name || !type) {
    return res.status(400).json({ error: 'Name and type are required' })
  }

  const id = `bot-${crypto.randomUUID()}`
  db.prepare(`
    INSERT INTO bots (id, name, type, status, industry, template_id, system_prompt, greeting, voice_style, voice_provider, voice_model, language, phone_number, llm_model, max_duration, transfer_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, name, type, status || 'draft', industry || null, template_id || null,
    system_prompt || '', greeting || '', voice_style || 'Cálida y profesional',
    voice_provider || 'openai', voice_model || 'alloy', language || 'es-MX',
    phone_number || null, llm_model || 'gpt-4o', max_duration || 300, transfer_number || null
  )

  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(id)

  // If bot is active and has a phone number, configure Twilio webhook
  if (bot.status === 'active' && bot.phone_number && process.env.TWILIO_ACCOUNT_SID) {
    try {
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
      const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`
      twilio.incomingPhoneNumbers.list({ phoneNumber: bot.phone_number })
        .then(numbers => {
          if (numbers.length > 0) {
            return twilio.incomingPhoneNumbers(numbers[0].sid).update({
              voiceUrl: `${baseUrl}/api/twilio/voice/${id}`,
              voiceMethod: 'POST'
            })
          }
        })
        .catch(err => console.error('Twilio webhook config error:', err.message))
    } catch (err) {
      console.error('Twilio init error:', err.message)
    }
  }

  res.status(201).json(bot)
})

app.put('/api/bots/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM bots WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Bot not found' })

  const fields = ['name', 'type', 'status', 'industry', 'system_prompt', 'greeting', 'voice_style', 'voice_provider', 'voice_model', 'language', 'phone_number', 'llm_model', 'max_duration', 'transfer_number']
  const updates = []
  const values = []

  for (const field of fields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`)
      values.push(req.body[field])
    }
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' })

  updates.push("updated_at = datetime('now')")
  values.push(req.params.id)

  db.prepare(`UPDATE bots SET ${updates.join(', ')} WHERE id = ?`).run(...values)
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(req.params.id)
  res.json(bot)
})

app.delete('/api/bots/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM bots WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Bot not found' })
  db.prepare('DELETE FROM bots WHERE id = ?').run(req.params.id)
  res.json({ message: 'Bot deleted' })
})

// ==================== CALLS ====================
app.get('/api/calls', (req, res) => {
  const { type, status, bot_id, limit } = req.query
  let query = 'SELECT c.*, b.name as bot_name FROM calls c LEFT JOIN bots b ON c.bot_id = b.id WHERE 1=1'
  const params = []

  if (type && type !== 'all') {
    query += ' AND c.type = ?'
    params.push(type)
  }
  if (status && status !== 'all') {
    query += ' AND c.status = ?'
    params.push(status)
  }
  if (bot_id) {
    query += ' AND c.bot_id = ?'
    params.push(bot_id)
  }

  query += ' ORDER BY c.started_at DESC'
  if (limit) {
    query += ' LIMIT ?'
    params.push(parseInt(limit))
  }

  const calls = db.prepare(query).all(...params)
  res.json(calls)
})

app.get('/api/calls/:id', (req, res) => {
  const call = db.prepare('SELECT c.*, b.name as bot_name FROM calls c LEFT JOIN bots b ON c.bot_id = b.id WHERE c.id = ?').get(req.params.id)
  if (!call) return res.status(404).json({ error: 'Call not found' })

  const messages = db.prepare('SELECT * FROM call_messages WHERE call_id = ? ORDER BY created_at').all(req.params.id)
  call.messages = messages
  res.json(call)
})

// Initiate outbound call
app.post('/api/calls/outbound', async (req, res) => {
  const { bot_id, contact_name, contact_phone } = req.body

  if (!bot_id || !contact_phone) {
    return res.status(400).json({ error: 'bot_id and contact_phone are required' })
  }

  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(bot_id)
  if (!bot) return res.status(404).json({ error: 'Bot not found' })
  if (bot.status !== 'active') return res.status(400).json({ error: 'Bot must be active to make calls' })

  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    return res.status(503).json({ error: 'Twilio not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.' })
  }

  const callId = `call-${crypto.randomUUID()}`
  db.prepare(`
    INSERT INTO calls (id, bot_id, contact_name, contact_phone, type, status)
    VALUES (?, ?, ?, ?, 'outbound', 'in_progress')
  `).run(callId, bot_id, contact_name || 'Unknown', contact_phone)

  // Store system prompt as first message
  db.prepare(`INSERT INTO call_messages (call_id, role, content) VALUES (?, 'system', ?)`).run(callId, bot.system_prompt)

  try {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`

    const twilioCall = await twilio.calls.create({
      to: contact_phone,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${baseUrl}/api/twilio/outbound/${callId}`,
      method: 'POST',
      statusCallback: `${baseUrl}/api/twilio/status/${callId}`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['completed', 'failed', 'no-answer', 'busy']
    })

    db.prepare('UPDATE calls SET twilio_call_sid = ? WHERE id = ?').run(twilioCall.sid, callId)

    const call = db.prepare('SELECT c.*, b.name as bot_name FROM calls c LEFT JOIN bots b ON c.bot_id = b.id WHERE c.id = ?').get(callId)
    res.status(201).json(call)
  } catch (err) {
    db.prepare("UPDATE calls SET status = 'failed', ended_at = datetime('now') WHERE id = ?").run(callId)
    res.status(500).json({ error: `Failed to initiate call: ${err.message}` })
  }
})

// ==================== ANALYTICS ====================
app.get('/api/analytics/overview', (req, res) => {
  const today = db.prepare(`
    SELECT 
      COUNT(*) as total_calls,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      AVG(CASE WHEN status = 'completed' THEN duration ELSE NULL END) as avg_duration,
      SUM(CASE WHEN sentiment = 'positive' THEN 1 ELSE 0 END) as positive
    FROM calls WHERE date(started_at) = date('now')
  `).get()

  const thisMonth = db.prepare(`
    SELECT 
      COUNT(*) as total_calls,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      AVG(CASE WHEN status = 'completed' THEN duration ELSE NULL END) as avg_duration
    FROM calls WHERE started_at >= date('now', 'start of month')
  `).get()

  const hourlyDistribution = db.prepare(`
    SELECT strftime('%H', started_at) as hour, COUNT(*) as count
    FROM calls WHERE date(started_at) = date('now')
    GROUP BY hour ORDER BY hour
  `).all()

  const weeklyTrend = db.prepare(`
    SELECT date(started_at) as day, 
      COUNT(*) as total,
      SUM(CASE WHEN type = 'inbound' THEN 1 ELSE 0 END) as inbound,
      SUM(CASE WHEN type = 'outbound' THEN 1 ELSE 0 END) as outbound
    FROM calls WHERE started_at >= date('now', '-7 days')
    GROUP BY day ORDER BY day
  `).all()

  const botPerformance = db.prepare(`
    SELECT b.id, b.name,
      COUNT(c.id) as total_calls,
      SUM(CASE WHEN c.status = 'completed' THEN 1 ELSE 0 END) as completed,
      AVG(c.duration) as avg_duration,
      AVG(CASE WHEN c.sentiment = 'positive' THEN 5 WHEN c.sentiment = 'neutral' THEN 3 ELSE 1 END) as satisfaction
    FROM bots b LEFT JOIN calls c ON b.id = c.bot_id
    WHERE b.status = 'active'
    GROUP BY b.id ORDER BY total_calls DESC
  `).all()

  res.json({
    today: {
      total_calls: today.total_calls || 0,
      success_rate: today.total_calls > 0 ? Math.round((today.completed / today.total_calls) * 100) : 0,
      avg_duration: Math.round(today.avg_duration || 0),
      satisfaction: today.total_calls > 0 ? Math.round((today.positive / today.total_calls) * 100) : 0
    },
    month: {
      total_calls: thisMonth.total_calls || 0,
      completed: thisMonth.completed || 0,
      avg_duration: Math.round(thisMonth.avg_duration || 0)
    },
    hourly_distribution: hourlyDistribution,
    weekly_trend: weeklyTrend,
    bot_performance: botPerformance.map(b => ({
      ...b,
      success_rate: b.total_calls > 0 ? Math.round((b.completed / b.total_calls) * 100) : 0,
      avg_duration: Math.round(b.avg_duration || 0),
      satisfaction: Math.round((b.satisfaction || 0) * 10) / 10
    }))
  })
})

// ==================== INTEGRATIONS ====================
app.get('/api/integrations', (req, res) => {
  const integrations = db.prepare('SELECT * FROM integrations ORDER BY name').all()
  res.json(integrations.map(i => ({ ...i, config: JSON.parse(i.config || '{}') })))
})

app.put('/api/integrations/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM integrations WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Integration not found' })

  const { status, config } = req.body
  const updates = []
  const values = []

  if (status) { updates.push('status = ?'); values.push(status) }
  if (config) { updates.push('config = ?'); values.push(JSON.stringify(config)) }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' })

  updates.push("updated_at = datetime('now')")
  values.push(req.params.id)

  db.prepare(`UPDATE integrations SET ${updates.join(', ')} WHERE id = ?`).run(...values)
  const integration = db.prepare('SELECT * FROM integrations WHERE id = ?').get(req.params.id)
  integration.config = JSON.parse(integration.config || '{}')
  res.json(integration)
})

// ==================== SETTINGS ====================
app.get('/api/settings', (req, res) => {
  const settings = db.prepare('SELECT * FROM settings').all()
  const result = {}
  settings.forEach(s => { result[s.key] = s.value })
  res.json(result)
})

app.put('/api/settings', (req, res) => {
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `)

  const updateMany = db.transaction((entries) => {
    for (const [key, value] of entries) {
      upsert.run(key, String(value))
    }
  })

  updateMany(Object.entries(req.body))
  res.json({ message: 'Settings updated' })
})

// ==================== TWILIO WEBHOOKS ====================
app.use('/api/twilio', twilioRoutes)

// ==================== CHAT COMPLETION (for testing) ====================
app.post('/api/chat', async (req, res) => {
  const { bot_id, message } = req.body
  if (!bot_id || !message) {
    return res.status(400).json({ error: 'bot_id and message are required' })
  }

  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(bot_id)
  if (!bot) return res.status(404).json({ error: 'Bot not found' })

  try {
    const response = await openaiService.chat(bot.system_prompt, [
      { role: 'assistant', content: bot.greeting },
      { role: 'user', content: message }
    ], bot.llm_model)
    res.json({ response })
  } catch (err) {
    res.status(500).json({ error: `AI error: ${err.message}` })
  }
})

// Start server - bind to 0.0.0.0 for cloud deployments
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Voicebot Commercial API running on port ${PORT}`)
  console.log(`Twilio: ${process.env.TWILIO_ACCOUNT_SID ? 'Configured' : 'Not configured'}`)
  console.log(`OpenAI: ${process.env.OPENAI_API_KEY ? 'Configured' : 'Not configured'}`)
  console.log(`Server is ready to accept connections`)
})

server.on('error', (err) => {
  console.error('SERVER ERROR:', err.message)
})
