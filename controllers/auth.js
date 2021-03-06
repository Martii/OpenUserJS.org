'use strict';

// Define some pseudo module globals
var isPro = require('../libs/debug').isPro;
var isDev = require('../libs/debug').isDev;
var isDbg = require('../libs/debug').isDbg;

//

//--- Dependency inclusions
var passport = require('passport');
var url = require('url');
var colors = require('ansi-colors');

//--- Model inclusions
var Strategy = require('../models/strategy.js').Strategy;
var User = require('../models/user').User;

//--- Controller inclusions

//--- Library inclusions
// var authLib = require('../libs/auth');

var loadPassport = require('../libs/passportLoader').loadPassport;
var strategyInstances = require('../libs/passportLoader').strategyInstances;
var verifyPassport = require('../libs/passportVerify').verify;
var cleanFilename = require('../libs/helpers').cleanFilename;
var addSession = require('../libs/modifySessions').add;
var expandSession = require('../libs/modifySessions').expand;
var statusCodePage = require('../libs/templateHelpers').statusCodePage;

//--- Configuration inclusions
var allStrategies = require('./strategies.json');

//---

// Unused but removing it breaks passport
passport.serializeUser(function (aUser, aDone) {
  aDone(null, aUser._id);
});

// Setup all the auth strategies
var openIdStrategies = {};
Strategy.find({}, function (aErr, aStrategies) {
  // WARNING: No err handling

  // Get OpenId strategies
  for (var name in allStrategies) {
    if (!allStrategies[name].oauth) {
      openIdStrategies[name] = true;
      aStrategies.push({ 'name': name, 'openid': true });
    }
  }

  // Load the passport module for each strategy
  aStrategies.forEach(function (aStrategy) {
    loadPassport(aStrategy);
  });
});

// Get the referer url for redirect after login/logout
// WARNING: Also found in `./controller/index.js`
function getRedirect(aReq) {
  var referer = aReq.get('Referer');
  var redirect = '/';

  if (referer) {
    referer = url.parse(referer);
    if (referer.hostname === aReq.hostname) {
      redirect = referer.path;
    }
  }

  return redirect;
}

exports.auth = function (aReq, aRes, aNext) {
  function auth() {
    var authenticate = null;

    // Just in case someone tries a bad /auth/* url
    // or an auth has been EOL'd
    if (!strategyInstances[strategy]) {
      aRes.redirect('/login?invalidauth');
      return;
    }

    if (strategy === 'google') {
      authOpts.scope = ['profile']; // NOTE: OAuth 2.0 profile
    }
    authenticate = passport.authenticate(strategy, authOpts);

    // Ensure `sameSite` is set to min before authenticating
    // Necessity to demote for authentication
    if (aReq.session.cookie.sameSite !== 'lax') {
      aReq.session.cookie.sameSite = 'lax';
      aReq.session.save(function (aErr) {
        // WARNING: No err handling

        authenticate(aReq, aRes, aNext);
      });
    } else {
      authenticate(aReq, aRes, aNext);
    }
  }

  var authedUser = aReq.session.user;
  var consent = aReq.body.consent;
  var strategy = aReq.body.auth || aReq.params.strategy;
  var username = aReq.body.username || aReq.session.username ||
    (authedUser ? authedUser.name : null);
  var authOpts = { failureRedirect: '/login?stratfail' };
  var passportKey = aReq._passport.instance._key;

  // Yet another passport hack.
  // Initialize the passport session data only when we need it.
  if (!aReq.session[passportKey] && aReq._passport.session) {
    aReq.session[passportKey] = {};
    aReq._passport.session = aReq.session[passportKey];
  }

  // Save redirect url from the form submission on the session
  aReq.session.redirectTo = aReq.body.redirectTo || getRedirect(aReq);

  // Allow a logged in user to add a new strategy
  if (strategy && authedUser) {
    aReq.session.passport.oujsOptions.authAttach = true;
    aReq.session.newstrategy = strategy;
    aReq.session.username = authedUser.name;
  } else if (authedUser) {
    aRes.redirect(aReq.session.redirectTo || '/');
    delete aReq.session.redirectTo;
    return;
  } else if (consent !== 'true') {
    aRes.redirect('/login?noconsent');
    return;
  }

  if (!username) {
    aRes.redirect('/login?noname');
    return;
  }
  // Clean the username of leading and trailing whitespace,
  // and other stuff that is unsafe in a url
  username = cleanFilename(username.replace(/^\s+|\s+$/g, ''));

  // The username could be empty after the replacements
  if (!username) {
    aRes.redirect('/login?noname');
    return;
  }

  if (username.length > 64) {
    aRes.redirect('/login?toolong');
    return;
  }

  // Store the username in the session so we still have it when they
  // get back from authentication
  if (!aReq.session.username) {
    aReq.session.username = username;
  }
  // Store the useragent always so we still have it when they
  // get back from authentication and attaching
  aReq.session.useragent = aReq.get('user-agent');

  User.findOne({ name: { $regex: new RegExp('^' + username + '$', 'i') } },
    function (aErr, aUser) {
      var strategies = null;
      var strat = null;

      if (aErr) {
        console.error('Authfail with no User found of', username, aErr);
        aRes.redirect('/login?usernamefail');
        return;
      }

      if (aUser) {
        // Ensure that casing is identical so we still have it, correctly, when they
        // get back from authentication
        if (aUser.name !== username) {
          aReq.session.username = aUser.name;
        }
        strategies = aUser.strategies;
        strat = strategies.pop();

        if (aReq.session.newstrategy) { // authenticate with a new strategy
          strategy = aReq.session.newstrategy;
        } else if (!strategy) { // use an existing strategy
          strategy = strat;
        } else if (strategies.indexOf(strategy) === -1) {
          // add a new strategy but first authenticate with existing strategy
          aReq.session.newstrategy = strategy;
          strategy = strat;
        } // else use the strategy that was given in the POST
      }

      if (!strategy) {
        aRes.redirect('/login');
        return;
      } else {
        auth();
        return;
      }
    });
};

exports.callback = function (aReq, aRes, aNext) {
  var strategy = aReq.params.strategy;
  var username = aReq.session.username;
  var newstrategy = aReq.session.newstrategy;
  var strategyInstance = null;
  var doneUri = aReq.session.user ? '/user/preferences' : '/';

  // The callback was called improperly or sesssion expired
  if (!strategy || !username) {
    aRes.redirect(doneUri + (doneUri === '/' ? 'login' : ''));
    return;
  }

  // Get the passport strategy instance so we can alter the _verify method
  strategyInstance = strategyInstances[strategy];

  // Hijack the private verify method so we can mess stuff up freely
  // We use this library for things it was never intended to do
  if (openIdStrategies[strategy]) {
    switch (strategy) {
      case 'steam':
        strategyInstance._verify = function (aIgnore, aId, aDone) {
          verifyPassport(aId, strategy, username, aReq.session.user, aDone);
        };
        break;
      default:
        strategyInstance._verify = function (aId, aDone) {
          verifyPassport(aId, strategy, username, aReq.session.user, aDone);
        };
    }
  } else {
    switch (strategy) {
      default:
        strategyInstance._verify = function (aToken, aRefreshOrSecretToken, aProfile, aDone) {
          aReq.session.profile = aProfile;
          verifyPassport(aProfile.id, strategy, username, aReq.session.user, aDone);
        };
    }
  }

  // This callback will happen after the verify routine
  var authenticate = passport.authenticate(strategy, function (aErr, aUser, aInfo) {
    if (aErr) {
      // Some possible catastrophic error with *passport*... and/or authentication
      console.error(colors.red(aErr));
      if (aInfo) {
        console.warn(colors.yellow(aInfo));
      }

      statusCodePage(aReq, aRes, aNext, {
        statusCode: 502,
        statusMessage: 'External authentication failed.'
      });
      return;
    }

    // If there is some info from *passport*... display it only in development and debug modes
    // This includes, but not limited to, `username is taken`
    if ((isDev || isDbg) && aInfo) {
      console.warn(colors.yellow(aInfo));
    }

    if (!aUser) {
      // If there is no User then authentication could have failed
      // Only display if development or debug modes
      if (isDev || isDbg) {
        console.error(colors.red('`User` not found'));
      }

      if (aInfo === 'readonly strategy') {
        aRes.redirect(doneUri + (doneUri === '/' ? 'login' : '') + '?roauth');
      } else if (aInfo === 'username recovered') {
        aRes.redirect(doneUri + (doneUri === '/' ? 'login' : '') + '?retryauth');
      } else {
        aRes.redirect(doneUri + (doneUri === '/' ? 'login' : '') + '?authfail');
      }
      return;
    }

    aReq.logIn(aUser, function (aErr) {
      if (aErr) {
        console.error('Not logged in');
        console.error(aErr);

        statusCodePage(aReq, aRes, aNext, {
          statusCode: 502,
          statusMessage: 'External authentication failed to login.'
        });
        return;
      }

      // Show a console notice that successfully logged in
      if (isDev || isDbg) {
        console.log(colors.green('Logged in'));
      }

      // Store the user info in the session
      aReq.session.user = aUser;

      // Store the info in the session passport
      // Currently we do not care to save this info in User
      // as it is volatile, absent, and usually session specific
      if (aReq.session.passport) {
        if (!aReq.session.passport.oujsOptions) {
          aReq.session.passport.oujsOptions = {};
        }
        aReq.session.passport.oujsOptions.remoteAddress = aReq.connection.remoteAddress;
        aReq.session.passport.oujsOptions.userAgent = aReq.session.useragent;
        aReq.session.passport.oujsOptions.since = new Date();
        aReq.session.passport.oujsOptions.strategy = strategy;
      }

      // Save the last date a user sucessfully logged in
      aUser.authed = new Date();

      // Save consent
      aUser.consented = true;

      // Save the session id on the user model
      aUser.sessionId = aReq.sessionID;

      // Save GitHub username.
      if (aReq.session.profile && aReq.session.profile.provider === 'github') {
        aUser.ghUsername = aReq.session.profile.username;
      }

      addSession(aReq, aUser, function () {
        if (newstrategy && newstrategy !== strategy) {
          // Allow a user to link to another account
          aRes.redirect('/auth/' + newstrategy); // NOTE: Watchpoint... careful with encoding
        } else {
          // Delete the username that was temporarily stored
          delete aReq.session.username;
          delete aReq.session.useragent;
          delete aReq.session.newstrategy;
          doneUri = aReq.session.redirectTo;
          delete aReq.session.redirectTo;

          if (!aReq.session.passport.oujsOptions.authAttach) {
            expandSession(aReq, aUser, function (aErr) {
              // WARNING: No err handling

              aRes.redirect(doneUri);
            });
          } else {
            aRes.redirect(doneUri);
          }

          // Ensure `sameSite` is set to max after redirect
          // Elevate for optimal future protection
          setTimeout(function () {
            if (aReq.session.cookie.sameSite !== 'strict') {
              aReq.session.cookie.sameSite = 'strict';
              aReq.session.save();
            }
          }, 500);
        }
      });
    });
  });

  authenticate(aReq, aRes, aNext);
};

exports.validateUser = function validateUser(aReq, aRes, aNext) {
  if (!aReq.session.user) {
    aRes.redirect('/login');
    return;
  }
  aNext();
  return;
};
