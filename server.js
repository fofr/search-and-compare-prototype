// Core dependencies
const path = require('path')

// NPM dependencies
const bodyParser = require('body-parser')
const dotenv = require('dotenv')
const express = require('express')
const nunjucks = require('nunjucks')
const sessionInCookie = require('client-sessions')
const sessionInMemory = require('express-session')
const cookieParser = require('cookie-parser')

// Run before other code to make sure variables from .env are available
dotenv.config()

// Local dependencies
const middleware = [
  require('./lib/middleware/authentication/authentication.js'),
  require('./lib/middleware/extensions/extensions.js')
]
const config = require('./app/config.js')
const packageJson = require('./package.json')
const routes = require('./app/routes.js')
const utils = require('./lib/utils.js')
const extensions = require('./lib/extensions/extensions.js')

const app = express()

// Set cookies for use in cookie banner.
app.use(cookieParser())
app.use(utils.handleCookies(app))

// Set up configuration variables
const releaseVersion = packageJson.version
const glitchEnv = (process.env.PROJECT_REMIX_CHAIN) ? 'production' : false // glitch.com
const env = (process.env.NODE_ENV || glitchEnv || 'development').toLowerCase()
const useAutoStoreData = process.env.USE_AUTO_STORE_DATA || config.useAutoStoreData
const useCookieSessionStore = process.env.USE_COOKIE_SESSION_STORE || config.useCookieSessionStore
let useHttps = process.env.USE_HTTPS || config.useHttps

useHttps = useHttps.toLowerCase()

// Force HTTPS on production. Do this before using basicAuth to avoid
// asking for username/password twice (for `http`, then `https`).
const isSecure = (env === 'production' && useHttps === 'true')
if (isSecure) {
  app.use(utils.forceHttps)
  app.set('trust proxy', 1) // needed for secure cookies on heroku
}

middleware.forEach(func => app.use(func))

// Set up App
const appViews = extensions.getAppViews([
  path.join(__dirname, '/app/views/'),
  path.join(__dirname, '/lib/')
])

const nunjucksConfig = {
  autoescape: true,
  noCache: true,
  watch: false // We are now setting this to `false` (it's by default false anyway) as having it set to `true` for production was making the tests hang
}

if (env === 'development') {
  nunjucksConfig.watch = true
}

nunjucksConfig.express = app

const nunjucksAppEnv = nunjucks.configure(appViews, nunjucksConfig)

// Add Nunjucks filters
utils.addNunjucksFilters(nunjucksAppEnv)

// Set views engine
app.set('view engine', 'html')

// Middleware to serve static assets
app.use('/public', express.static(path.join(__dirname, '/public')))

// Serve govuk-frontend in from node_modules (so not to break pre-extenstions prototype kits)
app.use('/node_modules/govuk-frontend', express.static(path.join(__dirname, '/node_modules/govuk-frontend')))

// Support for parsing data in POSTs
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({
  extended: true
}))

// Add variables that are available in all views
app.locals.asset_path = '/public/'
app.locals.useAutoStoreData = (useAutoStoreData === 'true')
app.locals.useCookieSessionStore = (useCookieSessionStore === 'true')
app.locals.cookieText = config.cookieText
app.locals.releaseVersion = 'v' + releaseVersion
app.locals.serviceName = config.serviceName
// extensionConfig sets up variables used to add the scripts and stylesheets to each page.
app.locals.extensionConfig = extensions.getAppConfig()

// Session uses service name to avoid clashes with other prototypes
const sessionName = 'govuk-prototype-kit-' + (Buffer.from(config.serviceName, 'utf8')).toString('hex')
const sessionOptions = {
  secret: sessionName,
  cookie: {
    maxAge: 1000 * 60 * 60 * 4, // 4 hours
    secure: isSecure
  }
}

// Support session data in cookie or memory
if (useCookieSessionStore === 'true') {
  app.use(sessionInCookie(Object.assign(sessionOptions, {
    cookieName: sessionName,
    proxy: true,
    requestKey: 'session'
  })))
} else {
  app.use(sessionInMemory(Object.assign(sessionOptions, {
    name: sessionName,
    resave: false,
    saveUninitialized: false
  })))
}

// Automatically store all data users enter
if (useAutoStoreData === 'true') {
  app.use(utils.autoStoreData)
  utils.addCheckedFunction(nunjucksAppEnv)
}

app.use(function (req, res, next) {
  nunjucksAppEnv.addGlobal('value', function (name) {
    if (req.session.data === undefined) {
      return ''
    }

    const value = req.session.data[name]
    if (value === undefined) {
      return ''
    }

    return value
  })

  nunjucksAppEnv.addGlobal('applyLink', function (providerCode, programmeCode) {
    const data = req.session.data
    const key = `${providerCode}-${programmeCode}`
    const APPLY_PROTOTYPE_URL = process.env.APPLY_PROTOTYPE_URL || 'https://apply-beta-prototype.herokuapp.com'

    const applyWithChoice = `${APPLY_PROTOTYPE_URL}/apply/${providerCode}/${programmeCode}?dualrunning=true`
    const applyWithoutChoice = `${APPLY_PROTOTYPE_URL}/apply/${providerCode}/${programmeCode}`

    // Keep each course consistent
    if (data[key]) {
      return data[key]
    }

    // If they've seen a course without a choice, force them to see one with
    if (data.seenApplyWithoutChoice) {
      return applyWithChoice
    }

    // If they've seen a course with a choice, force them to see one without
    if (data.seenApplyWithChoice) {
      return applyWithoutChoice
    }

    // Randomise whether course is in Apply beta or not (50/50)
    // return Math.random() >= 0.5 ? applyWithChoice : applyWithoutChoice;

    // Always show a course with a choice first
    return applyWithChoice
  })

  next()
})

// Clear all data in session if you open /prototype-admin/clear-data
app.post('/prototype-admin/clear-data', function (req, res) {
  req.session.data = {}
  res.render('prototype-admin/clear-data-success')
})

// Prevent search indexing
app.use(function (req, res, next) {
  // Setting headers stops pages being indexed even if indexed pages link to them.
  res.setHeader('X-Robots-Tag', 'noindex')
  next()
})

app.get('/robots.txt', function (req, res) {
  res.type('text/plain')
  res.send('User-agent: *\nDisallow: /')
})

// Load routes (found in app/routes.js)
if (typeof (routes) !== 'function') {
  console.log(routes.bind)
  console.log('Warning: the use of bind in routes is deprecated - please check the Prototype Kit documentation for writing routes.')
  routes.bind(app)
} else {
  app.use('/', routes)
}

// Strip .html and .htm if provided
app.get(/\.html?$/i, function (req, res) {
  let path = req.path
  const parts = path.split('.')
  parts.pop()
  path = parts.join('.')
  res.redirect(path)
})

// Auto render any view that exists

// App folder routes get priority
app.get(/^([^.]+)$/, function (req, res, next) {
  utils.matchRoutes(req, res, next)
})

// Redirect all POSTs to GETs - this allows users to use POST for autoStoreData
app.post(/^\/([^.]+)$/, function (req, res) {
  res.redirect('/' + req.params[0])
})

// Catch 404 and forward to error handler
app.use(function (req, res, next) {
  const err = new Error(`Page not found: ${req.path}`)
  err.status = 404
  next(err)
})

// Display error
app.use(function (err, req, res, next) {
  console.error(err.message)
  res.status(err.status || 500)
  res.send(err.message)
})

console.log('\nGOV.UK Prototype Kit v' + releaseVersion)
console.log('\nNOTICE: the kit is for building prototypes, do not use it for production services.')

module.exports = app
