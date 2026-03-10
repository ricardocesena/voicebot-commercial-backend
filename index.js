// Only load dotenv in development (Railway provides env vars natively)
try { require('dotenv').config() } catch (e) {}
const express = require('express')
const cors = require('cors')
const crypto = require('crypto')

console.log('ENV CHECK - PORT:', process.env.PORT, 'TWILIO_SID exists:', !!process.env.TWILIO_ACCOUNT_SID, 'OPENAI exists:', !!process.env.OPENAI_API_KEY, 'DATABASE_URL exists:', !!process.env.DATABASE_URL)

// Catch uncaught errors
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message, err.stack)
})
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err)
})

console.log('Loading database...')
const { pool, initDatabase } = require('./db')
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
app.get('/api/health', async (req, res) => {
  const twilioConfigured = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  const openaiConfigured = !!process.env.OPENAI_API_KEY
  let dbStatus = 'error'
  try {
    await pool.query('SELECT 1')
    dbStatus = 'connected'
  } catch (e) {
    dbStatus = 'error'
  }
  res.json({
    status: 'ok',
    services: {
      twilio: twilioConfigured ? 'configured' : 'not_configured',
      openai: openaiConfigured ? 'configured' : 'not_configured',
      database: dbStatus
    }
  })
})

// ==================== TEMPLATES ====================
app.get('/api/templates', async (req, res) => {
  try {
    const { category } = req.query
    let result
    if (category && category !== 'all') {
      result = await pool.query('SELECT * FROM templates WHERE category = $1 ORDER BY is_featured DESC, name', [category])
    } else {
      result = await pool.query('SELECT * FROM templates ORDER BY is_featured DESC, name')
    }
    const templates = result.rows.map(t => ({ ...t, features: JSON.parse(t.features || '[]') }))
    res.json(templates)
  } catch (err) {
    console.error('GET /api/templates error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/templates/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM templates WHERE id = $1', [req.params.id])
    if (result.rows.length === 0) return res.status(404).json({ error: 'Template not found' })
    const template = result.rows[0]
    template.features = JSON.parse(template.features || '[]')
    res.json(template)
  } catch (err) {
    console.error('GET /api/templates/:id error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ==================== BOTS ====================
app.get('/api/bots', async (req, res) => {
  try {
    const { status } = req.query
    let result
    if (status && status !== 'all') {
      result = await pool.query('SELECT * FROM bots WHERE status = $1 ORDER BY created_at DESC', [status])
    } else {
      result = await pool.query('SELECT * FROM bots ORDER BY created_at DESC')
    }
    const bots = []
    for (const bot of result.rows) {
      const stats = await pool.query(
        "SELECT COUNT(*) as total_calls, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_calls, AVG(duration) as avg_duration FROM calls WHERE bot_id = $1 AND DATE(started_at) = CURRENT_DATE",
        [bot.id]
      )
      const s = stats.rows[0]
      bots.push({
        ...bot,
        calls_today: parseInt(s.total_calls) || 0,
        success_rate: parseInt(s.total_calls) > 0 ? Math.round((parseInt(s.completed_calls) / parseInt(s.total_calls)) * 100) : 0,
        avg_duration: Math.round(parseFloat(s.avg_duration) || 0)
      })
    }
    res.json(bots)
  } catch (err) {
    console.error('GET /api/bots error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/bots/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bots WHERE id = $1', [req.params.id])
    if (result.rows.length === 0) return res.status(404).json({ error: 'Bot not found' })
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/bots', async (req, res) => {
  try {
    const { name, type, industry, template_id, system_prompt, greeting, voice_style, voice_provider, voice_model, language, phone_number, llm_model, max_duration, transfer_number, status } = req.body
    if (!name || !type) {
      return res.status(400).json({ error: 'Name and type are required' })
    }
    const id = 'bot-' + crypto.randomUUID()
    await pool.query(
      'INSERT INTO bots (id, name, type, status, industry, template_id, system_prompt, greeting, voice_style, voice_provider, voice_model, language, phone_number, llm_model, max_duration, transfer_number) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      [id, name, type, status || 'draft', industry || null, template_id || null, system_prompt || '', greeting || '', voice_style || 'Calida y profesional', voice_provider || 'openai', voice_model || 'alloy', language || 'es-MX', phone_number || null, llm_model || 'gpt-4o', max_duration || 300, transfer_number || null]
    )
    const result = await pool.query('SELECT * FROM bots WHERE id = $1', [id])
    const bot = result.rows[0]

    if (bot.status === 'active' && bot.phone_number && process.env.TWILIO_ACCOUNT_SID) {
      try {
        const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
        const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT)
        const numbers = await twilio.incomingPhoneNumbers.list({ phoneNumber: bot.phone_number })
        if (numbers.length > 0) {
          await twilio.incomingPhoneNumbers(numbers[0].sid).update({ voiceUrl: baseUrl + '/api/twilio/voice/' + id, voiceMethod: 'POST' })
        }
      } catch (err) { console.error('Twilio webhook config error:', err.message) }
    }
    res.status(201).json(bot)
  } catch (err) {
    console.error('POST /api/bots error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.put('/api/bots/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM bots WHERE id = $1', [req.params.id])
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Bot not found' })
    const fields = ['name', 'type', 'status', 'industry', 'system_prompt', 'greeting', 'voice_style', 'voice_provider', 'voice_model', 'language', 'phone_number', 'llm_model', 'max_duration', 'transfer_number']
    const updates = []
    const values = []
    let paramIdx = 1
    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(field + ' = $' + paramIdx)
        values.push(req.body[field])
        paramIdx++
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' })
    updates.push('updated_at = NOW()')
    values.push(req.params.id)
    await pool.query('UPDATE bots SET ' + updates.join(', ') + ' WHERE id = $' + paramIdx, values)
    const result = await pool.query('SELECT * FROM bots WHERE id = $1', [req.params.id])
    res.json(result.rows[0])
  } catch (err) {
    console.error('PUT /api/bots/:id error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Activate a bot - deactivates all others (only 1 active at a time)
app.post('/api/bots/:id/activate', async (req, res) => {
  const client = await pool.connect()
  try {
    const existing = await client.query('SELECT * FROM bots WHERE id = $1', [req.params.id])
    if (existing.rows.length === 0) { client.release(); return res.status(404).json({ error: 'Bot not found' }) }
    await client.query('BEGIN')
    await client.query("UPDATE bots SET status = 'paused', updated_at = NOW() WHERE status = 'active'")
    await client.query("UPDATE bots SET status = 'active', updated_at = NOW() WHERE id = $1", [req.params.id])
    await client.query('COMMIT')
    const result = await client.query('SELECT * FROM bots WHERE id = $1', [req.params.id])
    client.release()
    res.json(result.rows[0])
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
    console.error('POST /api/bots/:id/activate error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/bots/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM bots WHERE id = $1', [req.params.id])
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Bot not found' })
    await pool.query('DELETE FROM call_messages WHERE call_id IN (SELECT id FROM calls WHERE bot_id = $1)', [req.params.id])
    await pool.query('DELETE FROM calls WHERE bot_id = $1', [req.params.id])
    await pool.query('DELETE FROM bots WHERE id = $1', [req.params.id])
    res.json({ message: 'Bot deleted' })
  } catch (err) {
    console.error('DELETE /api/bots/:id error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ==================== CALLS ====================
app.get('/api/calls', async (req, res) => {
  try {
    const { type, status, bot_id, limit } = req.query
    let query = 'SELECT c.*, b.name as bot_name FROM calls c LEFT JOIN bots b ON c.bot_id = b.id WHERE 1=1'
    const params = []
    let paramIdx = 1
    if (type && type !== 'all') { query += ' AND c.type = $' + paramIdx; params.push(type); paramIdx++ }
    if (status && status !== 'all') { query += ' AND c.status = $' + paramIdx; params.push(status); paramIdx++ }
    if (bot_id) { query += ' AND c.bot_id = $' + paramIdx; params.push(bot_id); paramIdx++ }
    query += ' ORDER BY c.started_at DESC'
    if (limit) { query += ' LIMIT $' + paramIdx; params.push(parseInt(limit)) }
    const result = await pool.query(query, params)
    res.json(result.rows)
  } catch (err) {
    console.error('GET /api/calls error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/calls/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT c.*, b.name as bot_name FROM calls c LEFT JOIN bots b ON c.bot_id = b.id WHERE c.id = $1', [req.params.id])
    if (result.rows.length === 0) return res.status(404).json({ error: 'Call not found' })
    const messages = await pool.query('SELECT * FROM call_messages WHERE call_id = $1 ORDER BY created_at', [req.params.id])
    const call = result.rows[0]
    call.messages = messages.rows
    res.json(call)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Initiate outbound call
app.post('/api/calls/outbound', async (req, res) => {
  try {
    const { bot_id, contact_name, contact_phone } = req.body
    if (!bot_id || !contact_phone) return res.status(400).json({ error: 'bot_id and contact_phone are required' })
    const botResult = await pool.query('SELECT * FROM bots WHERE id = $1', [bot_id])
    if (botResult.rows.length === 0) return res.status(404).json({ error: 'Bot not found' })
    const bot = botResult.rows[0]
    if (bot.status !== 'active') return res.status(400).json({ error: 'Bot must be active to make calls' })
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return res.status(503).json({ error: 'Twilio not configured.' })
    const callId = 'call-' + crypto.randomUUID()
    await pool.query("INSERT INTO calls (id, bot_id, contact_name, contact_phone, type, status) VALUES ($1,$2,$3,$4,'outbound','in_progress')", [callId, bot_id, contact_name || 'Unknown', contact_phone])
    await pool.query("INSERT INTO call_messages (call_id, role, content) VALUES ($1, 'system', $2)", [callId, bot.system_prompt])
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT)
    const twilioCall = await twilio.calls.create({ to: contact_phone, from: process.env.TWILIO_PHONE_NUMBER, url: baseUrl + '/api/twilio/outbound/' + callId, method: 'POST', statusCallback: baseUrl + '/api/twilio/status/' + callId, statusCallbackMethod: 'POST', statusCallbackEvent: ['completed', 'failed', 'no-answer', 'busy'] })
    await pool.query('UPDATE calls SET twilio_call_sid = $1 WHERE id = $2', [twilioCall.sid, callId])
    const callResult = await pool.query('SELECT c.*, b.name as bot_name FROM calls c LEFT JOIN bots b ON c.bot_id = b.id WHERE c.id = $1', [callId])
    res.status(201).json(callResult.rows[0])
  } catch (err) {
    console.error('POST /api/calls/outbound error:', err.message)
    res.status(500).json({ error: 'Failed to initiate call: ' + err.message })
  }
})

// ==================== ANALYTICS ====================
app.get('/api/analytics/overview', async (req, res) => {
  try {
    const today = await pool.query("SELECT COUNT(*) as total_calls, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed, AVG(CASE WHEN status = 'completed' THEN duration ELSE NULL END) as avg_duration, SUM(CASE WHEN sentiment = 'positive' THEN 1 ELSE 0 END) as positive FROM calls WHERE DATE(started_at) = CURRENT_DATE")
    const thisMonth = await pool.query("SELECT COUNT(*) as total_calls, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed, AVG(CASE WHEN status = 'completed' THEN duration ELSE NULL END) as avg_duration FROM calls WHERE started_at >= date_trunc('month', CURRENT_DATE)")
    const hourlyDistribution = await pool.query("SELECT EXTRACT(HOUR FROM started_at)::text as hour, COUNT(*) as count FROM calls WHERE DATE(started_at) = CURRENT_DATE GROUP BY hour ORDER BY hour")
    const weeklyTrend = await pool.query("SELECT DATE(started_at)::text as day, COUNT(*) as total, SUM(CASE WHEN type = 'inbound' THEN 1 ELSE 0 END) as inbound, SUM(CASE WHEN type = 'outbound' THEN 1 ELSE 0 END) as outbound FROM calls WHERE started_at >= CURRENT_DATE - INTERVAL '7 days' GROUP BY day ORDER BY day")
    const botPerformance = await pool.query("SELECT b.id, b.name, COUNT(c.id) as total_calls, SUM(CASE WHEN c.status = 'completed' THEN 1 ELSE 0 END) as completed, AVG(c.duration) as avg_duration, AVG(CASE WHEN c.sentiment = 'positive' THEN 5 WHEN c.sentiment = 'neutral' THEN 3 ELSE 1 END) as satisfaction FROM bots b LEFT JOIN calls c ON b.id = c.bot_id WHERE b.status = 'active' GROUP BY b.id, b.name ORDER BY total_calls DESC")
    const t = today.rows[0]
    const m = thisMonth.rows[0]
    res.json({
      today: { total_calls: parseInt(t.total_calls) || 0, success_rate: parseInt(t.total_calls) > 0 ? Math.round((parseInt(t.completed) / parseInt(t.total_calls)) * 100) : 0, avg_duration: Math.round(parseFloat(t.avg_duration) || 0), satisfaction: parseInt(t.total_calls) > 0 ? Math.round((parseInt(t.positive) / parseInt(t.total_calls)) * 100) : 0 },
      month: { total_calls: parseInt(m.total_calls) || 0, completed: parseInt(m.completed) || 0, avg_duration: Math.round(parseFloat(m.avg_duration) || 0) },
      hourly_distribution: hourlyDistribution.rows,
      weekly_trend: weeklyTrend.rows,
      bot_performance: botPerformance.rows.map(b => ({ ...b, success_rate: parseInt(b.total_calls) > 0 ? Math.round((parseInt(b.completed) / parseInt(b.total_calls)) * 100) : 0, avg_duration: Math.round(parseFloat(b.avg_duration) || 0), satisfaction: Math.round((parseFloat(b.satisfaction) || 0) * 10) / 10 }))
    })
  } catch (err) {
    console.error('GET /api/analytics/overview error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ==================== INTEGRATIONS ====================
app.get('/api/integrations', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM integrations ORDER BY name')
    res.json(result.rows.map(i => ({ ...i, config: JSON.parse(i.config || '{}') })))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.put('/api/integrations/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM integrations WHERE id = $1', [req.params.id])
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Integration not found' })
    const { status, config } = req.body
    const updates = []; const values = []; let paramIdx = 1
    if (status) { updates.push('status = $' + paramIdx); values.push(status); paramIdx++ }
    if (config) { updates.push('config = $' + paramIdx); values.push(JSON.stringify(config)); paramIdx++ }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' })
    updates.push('updated_at = NOW()')
    values.push(req.params.id)
    await pool.query('UPDATE integrations SET ' + updates.join(', ') + ' WHERE id = $' + paramIdx, values)
    const result = await pool.query('SELECT * FROM integrations WHERE id = $1', [req.params.id])
    const integration = result.rows[0]
    integration.config = JSON.parse(integration.config || '{}')
    res.json(integration)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ==================== SETTINGS ====================
app.get('/api/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM settings')
    const settings = {}
    result.rows.forEach(s => { settings[s.key] = s.value })
    res.json(settings)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.put('/api/settings', async (req, res) => {
  try {
    for (const [key, value] of Object.entries(req.body)) {
      await pool.query("INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()", [key, String(value)])
    }
    res.json({ message: 'Settings updated' })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ==================== TWILIO WEBHOOKS ====================
app.use('/api/twilio', twilioRoutes)

// ==================== CHAT COMPLETION (for testing) ====================
app.post('/api/chat', async (req, res) => {
  const { bot_id, message } = req.body
  if (!bot_id || !message) return res.status(400).json({ error: 'bot_id and message are required' })
  try {
    const result = await pool.query('SELECT * FROM bots WHERE id = $1', [bot_id])
    if (result.rows.length === 0) return res.status(404).json({ error: 'Bot not found' })
    const bot = result.rows[0]
    const response = await openaiService.chat(bot.system_prompt, [{ role: 'assistant', content: bot.greeting }, { role: 'user', content: message }], bot.llm_model)
    res.json({ response })
  } catch (err) { res.status(500).json({ error: 'AI error: ' + err.message }) }
})

// Initialize database and start server
async function startServer() {
  try {
    await initDatabase()
    console.log('Database initialized')
  } catch (err) {
    console.error('DATABASE INIT ERROR:', err.message)
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('Voicebot Commercial API running on port ' + PORT)
    console.log('Twilio: ' + (process.env.TWILIO_ACCOUNT_SID ? 'Configured' : 'Not configured'))
    console.log('OpenAI: ' + (process.env.OPENAI_API_KEY ? 'Configured' : 'Not configured'))
    console.log('Database: PostgreSQL via DATABASE_URL')
    console.log('Server is ready to accept connections')
  })

  server.on('error', (err) => { console.error('SERVER ERROR:', err.message) })
}

startServer()
