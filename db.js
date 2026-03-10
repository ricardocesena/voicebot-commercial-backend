const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
})

async function initDatabase() {
  const client = await pool.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('inbound', 'outbound')),
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('active', 'paused', 'draft')),
        industry TEXT,
        template_id TEXT,
        system_prompt TEXT,
        greeting TEXT,
        voice_style TEXT DEFAULT 'Calida y profesional',
        voice_provider TEXT DEFAULT 'openai',
        voice_model TEXT DEFAULT 'alloy',
        language TEXT DEFAULT 'es-MX',
        phone_number TEXT,
        llm_model TEXT DEFAULT 'gpt-4o',
        max_duration INTEGER DEFAULT 300,
        transfer_number TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('inbound', 'outbound')),
        industry TEXT,
        description TEXT,
        features TEXT,
        voice_style TEXT,
        avg_duration TEXT,
        success_rate TEXT,
        system_prompt TEXT,
        greeting TEXT,
        language TEXT DEFAULT 'es-MX',
        icon TEXT,
        is_featured INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY,
        bot_id TEXT REFERENCES bots(id),
        contact_name TEXT,
        contact_phone TEXT,
        type TEXT NOT NULL CHECK(type IN ('inbound', 'outbound')),
        status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('completed', 'in_progress', 'failed', 'transferred')),
        duration INTEGER DEFAULT 0,
        sentiment TEXT DEFAULT 'neutral' CHECK(sentiment IN ('positive', 'neutral', 'negative')),
        transcript TEXT,
        twilio_call_sid TEXT,
        started_at TIMESTAMP DEFAULT NOW(),
        ended_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS call_messages (
        id SERIAL PRIMARY KEY,
        call_id TEXT NOT NULL REFERENCES calls(id),
        role TEXT NOT NULL CHECK(role IN ('system', 'assistant', 'user')),
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS integrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'disconnected' CHECK(status IN ('connected', 'disconnected', 'error')),
        config TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `)

    // Seed default templates if empty
    const templateCount = await client.query('SELECT COUNT(*) as count FROM templates')
    if (parseInt(templateCount.rows[0].count) === 0) {
      const templates = [
        {
          id: 'tmpl-health-receptionist',
          name: 'Recepcionista de Salud',
          category: 'inbound',
          industry: 'Salud',
          description: 'Agente AI para clinicas y hospitales que agenda citas, responde preguntas frecuentes y transfiere llamadas urgentes.',
          features: JSON.stringify(['Agendamiento en tiempo real', 'Verificacion de pacientes', 'Manejo de urgencias', 'Recordatorios automaticos']),
          voice_style: 'Calida y profesional',
          avg_duration: '3:45',
          success_rate: '94%',
          system_prompt: 'Eres Jessica, una recepcionista virtual para una clinica medica. Tu objetivo es ayudar a los pacientes a agendar citas, verificar su informacion y responder preguntas sobre horarios y servicios disponibles. Siempre manten un tono calido y empatico.',
          greeting: 'Hola! Gracias por llamar a la Clinica San Rafael. Soy Jessica, su asistente virtual. En que puedo ayudarle hoy?',
          language: 'es-MX',
          icon: 'Heart',
          is_featured: 1
        },
        {
          id: 'tmpl-real-estate-leads',
          name: 'Calificacion de Leads Inmobiliarios',
          category: 'inbound',
          industry: 'Bienes Raices',
          description: 'Califica compradores potenciales, identifica preferencias de propiedad y agenda visitas automaticamente.',
          features: JSON.stringify(['Calificacion de leads', 'Captura de preferencias', 'Agendamiento de visitas', 'Seguimiento automatico']),
          voice_style: 'Entusiasta y conocedora',
          avg_duration: '4:20',
          success_rate: '87%',
          system_prompt: 'Eres Sofia, una asesora inmobiliaria virtual. Tu trabajo es calificar a los compradores potenciales, entender sus necesidades de vivienda (presupuesto, ubicacion, tamano) y agendar visitas con los asesores.',
          greeting: 'Bienvenido a Inmobiliaria Premier! Soy Sofia, su asesora virtual. Me encantaria ayudarle a encontrar la propiedad perfecta. Esta buscando comprar o rentar?',
          language: 'es-MX',
          icon: 'Building2',
          is_featured: 1
        },
        {
          id: 'tmpl-ecommerce-support',
          name: 'Soporte E-Commerce',
          category: 'inbound',
          industry: 'E-Commerce',
          description: 'Atiende consultas de pedidos, devoluciones, estado de envio y preguntas frecuentes de tienda online.',
          features: JSON.stringify(['Tracking de pedidos', 'Gestion de devoluciones', 'FAQ automatico', 'Escalamiento inteligente']),
          voice_style: 'Amigable y eficiente',
          avg_duration: '2:50',
          success_rate: '91%',
          system_prompt: 'Eres Alex, un agente de soporte virtual para una tienda online. Ayudas a los clientes con el estado de sus pedidos, procesas devoluciones, respondes preguntas sobre productos y resuelves problemas de envio.',
          greeting: 'Hola! Gracias por contactar nuestra tienda. Soy Alex, tu asistente virtual. En que puedo ayudarte? Puedo verificar el estado de tu pedido, ayudarte con una devolucion o resolver cualquier duda.',
          language: 'es-MX',
          icon: 'ShoppingCart',
          is_featured: 0
        },
        {
          id: 'tmpl-financial-services',
          name: 'Servicios Financieros',
          category: 'inbound',
          industry: 'Finanzas',
          description: 'Verifica identidad de clientes, procesa solicitudes de informacion de cuentas y dirige llamadas al area correcta.',
          features: JSON.stringify(['Verificacion de identidad', 'Consulta de saldos', 'Transferencia a ejecutivo', 'Bloqueo de tarjetas']),
          voice_style: 'Formal y confiable',
          avg_duration: '3:15',
          success_rate: '88%',
          system_prompt: 'Eres Diana, una asistente bancaria virtual. Tu prioridad es la seguridad del cliente. Siempre verifica la identidad antes de dar informacion. Puedes ayudar con consultas de saldo, movimientos recientes y transferir a un ejecutivo cuando sea necesario.',
          greeting: 'Bienvenido a Banco Comercial. Soy Diana, su asistente virtual. Para poder ayudarle, necesitare verificar su identidad. Podria proporcionarme su numero de cliente?',
          language: 'es-MX',
          icon: 'Shield',
          is_featured: 1
        },
        {
          id: 'tmpl-restaurant-reservations',
          name: 'Reservaciones de Restaurante',
          category: 'inbound',
          industry: 'Restaurantes',
          description: 'Gestiona reservaciones, consultas de menu, eventos especiales y horarios de atencion.',
          features: JSON.stringify(['Reservaciones en tiempo real', 'Informacion de menu', 'Eventos especiales', 'Lista de espera']),
          voice_style: 'Cordial y atenta',
          avg_duration: '2:30',
          success_rate: '96%',
          system_prompt: 'Eres Valentina, la hostess virtual del restaurante. Gestionas reservaciones, informas sobre el menu del dia, horarios y eventos especiales. Siempre se amable y crea una experiencia acogedora.',
          greeting: 'Buenas tardes! Gracias por llamar al Restaurante La Terraza. Soy Valentina, su asistente virtual. Desea hacer una reservacion o tiene alguna consulta sobre nuestro menu?',
          language: 'es-MX',
          icon: 'Home',
          is_featured: 0
        },
        {
          id: 'tmpl-b2b-sales',
          name: 'Ventas Outbound B2B',
          category: 'outbound',
          industry: 'Ventas',
          description: 'Realiza llamadas de prospeccion, califica leads empresariales y agenda demos de productos.',
          features: JSON.stringify(['Prospeccion automatizada', 'Pitch personalizado', 'Agendamiento de demos', 'CRM integration']),
          voice_style: 'Profesional y persuasiva',
          avg_duration: '5:10',
          success_rate: '32%',
          system_prompt: 'Eres Marcos, un ejecutivo de ventas virtual. Tu objetivo es contactar prospectos empresariales, presentar brevemente la solucion, identificar necesidades y agendar una demo con el equipo de ventas. Se profesional pero no agresivo.',
          greeting: 'Buenos dias, hablo con [NOMBRE]? Mi nombre es Marcos y le llamo de TechSolutions. Tenemos una plataforma que esta ayudando a empresas como la suya a reducir costos operativos hasta un 40%. Tiene un par de minutos?',
          language: 'es-MX',
          icon: 'Zap',
          is_featured: 1
        },
        {
          id: 'tmpl-satisfaction-surveys',
          name: 'Encuestas de Satisfaccion',
          category: 'outbound',
          industry: 'Investigacion',
          description: 'Realiza encuestas post-servicio, recopila NPS y feedback de clientes de forma automatizada.',
          features: JSON.stringify(['Encuestas NPS', 'Recopilacion de feedback', 'Analisis de sentimiento', 'Reportes automaticos']),
          voice_style: 'Neutral y amable',
          avg_duration: '2:15',
          success_rate: '68%',
          system_prompt: 'Eres Laura, una encuestadora virtual. Tu trabajo es realizar encuestas de satisfaccion breves y amables. Haz las preguntas de forma natural y registra las respuestas. Si el cliente no quiere participar, agradece su tiempo amablemente.',
          greeting: 'Hola, hablo con [NOMBRE]? Mi nombre es Laura y le llamo de parte de [EMPRESA]. Queremos mejorar nuestro servicio y su opinion es muy importante. Podria responder 3 preguntas rapidas? No le tomara mas de 2 minutos.',
          language: 'es-MX',
          icon: 'Star',
          is_featured: 0
        },
        {
          id: 'tmpl-appointment-reminders',
          name: 'Recordatorios de Citas',
          category: 'outbound',
          industry: 'Salud',
          description: 'Llama a pacientes para confirmar, reprogramar o cancelar citas medicas programadas.',
          features: JSON.stringify(['Confirmacion de citas', 'Reprogramacion flexible', 'Cancelaciones', 'Recordatorio de preparacion']),
          voice_style: 'Cuidadosa y clara',
          avg_duration: '1:45',
          success_rate: '85%',
          system_prompt: 'Eres Carmen, una asistente de recordatorios medicos. Tu trabajo es confirmar citas, ofrecer reprogramacion si es necesario y recordar instrucciones de preparacion para procedimientos. Se clara y amable.',
          greeting: 'Hola, hablo con [NOMBRE]? Le llamo de la Clinica San Rafael para recordarle que tiene una cita programada para [FECHA] a las [HORA] con el Dr. [DOCTOR]. Puede confirmar su asistencia?',
          language: 'es-MX',
          icon: 'Clock',
          is_featured: 0
        },
        {
          id: 'tmpl-friendly-collections',
          name: 'Cobranza Amigable',
          category: 'outbound',
          industry: 'Finanzas',
          description: 'Gestion de cobros con enfoque empatico, ofrece planes de pago y registra compromisos.',
          features: JSON.stringify(['Cobro empatico', 'Planes de pago', 'Registro de compromisos', 'Escalamiento automatico']),
          voice_style: 'Empatica pero firme',
          avg_duration: '4:00',
          success_rate: '45%',
          system_prompt: 'Eres Patricia, una gestora de cobranza virtual. Tu enfoque es amable y empatico. Informa sobre el adeudo, ofrece planes de pago flexibles y registra compromisos. Nunca amenaces ni seas agresiva.',
          greeting: 'Hola, hablo con [NOMBRE]? Mi nombre es Patricia y le llamo de [EMPRESA]. Le contacto respecto a su cuenta. Tenemos algunas opciones que podrian ayudarle. Tiene un momento para que le explique?',
          language: 'es-MX',
          icon: 'FileText',
          is_featured: 0
        },
        {
          id: 'tmpl-tech-support',
          name: 'Soporte Tecnico 24/7',
          category: 'inbound',
          industry: 'Tecnologia',
          description: 'Resuelve problemas tecnicos de Nivel 1, guia al usuario paso a paso y escala tickets complejos.',
          features: JSON.stringify(['Diagnostico guiado', 'Resolucion Nivel 1', 'Creacion de tickets', 'Base de conocimiento']),
          voice_style: 'Paciente y tecnica',
          avg_duration: '5:30',
          success_rate: '78%',
          system_prompt: 'Eres Roberto, un tecnico de soporte virtual. Ayudas a resolver problemas tecnicos guiando al usuario paso a paso. Si el problema es complejo, creas un ticket de escalacion. Siempre se paciente y explica en terminos sencillos.',
          greeting: 'Hola! Bienvenido al Soporte Tecnico. Soy Roberto, su asistente virtual. Estoy aqui para ayudarle a resolver cualquier problema tecnico. Podria describirme brevemente que esta experimentando?',
          language: 'es-MX',
          icon: 'Workflow',
          is_featured: 0
        }
      ]

      for (const t of templates) {
        await client.query(
          `INSERT INTO templates (id, name, category, industry, description, features, voice_style, avg_duration, success_rate, system_prompt, greeting, language, icon, is_featured)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [t.id, t.name, t.category, t.industry, t.description, t.features, t.voice_style, t.avg_duration, t.success_rate, t.system_prompt, t.greeting, t.language, t.icon, t.is_featured]
        )
      }
      console.log('Templates seeded successfully')
    }

    // Seed default integrations if empty
    const intCount = await client.query('SELECT COUNT(*) as count FROM integrations')
    if (parseInt(intCount.rows[0].count) === 0) {
      const integrations = [
        { id: 'int-salesforce', name: 'Salesforce', type: 'crm', status: 'disconnected', config: '{}' },
        { id: 'int-hubspot', name: 'HubSpot', type: 'crm', status: 'disconnected', config: '{}' },
        { id: 'int-twilio', name: 'Twilio', type: 'telephony', status: 'disconnected', config: '{}' },
        { id: 'int-google-calendar', name: 'Google Calendar', type: 'scheduling', status: 'disconnected', config: '{}' },
        { id: 'int-zapier', name: 'Zapier', type: 'automation', status: 'disconnected', config: '{}' },
        { id: 'int-slack', name: 'Slack', type: 'messaging', status: 'disconnected', config: '{}' },
        { id: 'int-whatsapp', name: 'WhatsApp Business', type: 'messaging', status: 'disconnected', config: '{}' },
        { id: 'int-google-sheets', name: 'Google Sheets', type: 'data', status: 'disconnected', config: '{}' },
        { id: 'int-stripe', name: 'Stripe', type: 'payments', status: 'disconnected', config: '{}' },
        { id: 'int-mailchimp', name: 'Mailchimp', type: 'email', status: 'disconnected', config: '{}' },
        { id: 'int-zendesk', name: 'Zendesk', type: 'support', status: 'disconnected', config: '{}' },
        { id: 'int-webhook', name: 'Webhooks', type: 'custom', status: 'disconnected', config: '{}' },
      ]

      for (const i of integrations) {
        await client.query(
          'INSERT INTO integrations (id, name, type, status, config) VALUES ($1, $2, $3, $4, $5)',
          [i.id, i.name, i.type, i.status, i.config]
        )
      }
      console.log('Integrations seeded successfully')
    }

    console.log('Database initialized successfully')
  } finally {
    client.release()
  }
}

module.exports = { pool, initDatabase }
