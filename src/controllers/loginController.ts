import crypto from 'crypto';
import ejs from 'ejs';
import BetaGouv from '../betagouv';
import config from '../config';
import knex from '../db';
import * as utils from './utils';
import { EmailStatusCode } from '../models/dbUser';

function renderLogin(req, res, params) {
  res.render('login', {
    // init params
    currentUser: undefined,
    domain: config.domain,
    nextParam: req.query.next ? `?next=${req.query.next}${req.query.anchor ? `&anchor=` + req.query.anchor : ''}` : '',
    // enrich params
    errors: req.flash('error'),
    messages: req.flash('message'),
  });
}

export function generateToken() {
  return crypto.randomBytes(256).toString('base64');
}

async function sendLoginEmail(email: string, username: string, loginUrlWithToken: string) {
  const user = await BetaGouv.userInfosById(username);

  if (!user) {
    throw new Error(
      `Membre ${username} inconnu·e sur ${config.domain}. Avez-vous une fiche sur Github ?`
    );
  }

  if (utils.checkUserIsExpired(user, 5)) {
    throw new Error(`Membre ${username} a une date de fin expiré sur Github.`);
  }

  const html = await ejs.renderFile('./views/emails/login.ejs', {
    loginUrlWithToken,
  });

  try {
    await utils.sendMail(email, 'Connexion au secrétariat BetaGouv', html);
  } catch (err) {
    console.error(err);
    throw new Error("Erreur d'envoi de mail à ton adresse.");
  }
}

export async function saveToken(username, token) {
  const email = await knex('users').where({
    username
  }).then(dbResponse => {
    return dbResponse[0].primary_email
  });
  try {
    const expirationDate = new Date();
    expirationDate.setHours(expirationDate.getHours() + 1);

    await knex('login_tokens').insert({
      token,
      username,
      email: email,
      expires_at: expirationDate,
    });
    console.log(`Login token créé pour ${email}`);
  } catch (err) {
    console.error(`Erreur de sauvegarde du token : ${err}`);
    throw new Error('Erreur de sauvegarde du token');
  }
}

export async function getLogin(req, res) {
  renderLogin(req, res, {});
}

export async function postLogin(req, res) {
  const formValidationErrors = [];
  const nextParam = req.query.next ? `?next=${req.query.next}${req.query.anchor ? `&anchor=` + req.query.anchor : ''}` : ''
  const emailInput = req.body.emailInput.toLowerCase() || utils.isValidEmail(formValidationErrors, 'email', req.body.emailInput.toLowerCase());

  if (formValidationErrors.length) {
    req.flash('error', formValidationErrors);
    return res.redirect(`/login${nextParam}`);
  }

  let username;

  const emailSplit = emailInput.split('@');
  if (emailSplit[1] === config.domain) {
    username = emailSplit[0];
    if (username === undefined || !/^[a-z0-9_-]+\.[a-z0-9_-]+$/.test(username)) {
      req.flash(
        'error',
        `Le nom de l'adresse email renseigné n'a pas le bon format. Il doit contenir des caractères alphanumériques en minuscule et un '.' Exemple : charlotte.duret@${config.domain}`
      );
      return res.redirect(`/login${nextParam}`);
    }
  } else {
      try {
        const dbResponse = await knex('users')
        .select()
        .whereRaw(`LOWER(secondary_email) = ?`, emailInput)
        .orWhereRaw(`(LOWER(primary_email) = ? and primary_email_status = '${EmailStatusCode.EMAIL_ACTIVE}')`, emailInput)
        username = dbResponse[0].username;
      } catch (e) {
        req.flash(
          'error',
          `L'adresse email ${emailInput} n'est pas connue.`
        );
        return res.redirect(`/login${nextParam}`);
      }
  }

  const secretariatUrl = `${config.protocol}://${req.get('host')}`;
  const loginUrl: URL = new URL(secretariatUrl + (req.query.next || config.defaultLoggedInRedirectUrl) + (req.query.anchor ? `#${req.query.anchor}` : ''));

  try {
    const token = generateToken();
    loginUrl.searchParams.append('token', token)
    await sendLoginEmail(emailInput, username, loginUrl.toString());
    await saveToken(username, token);

    return renderLogin(req, res, {
      messages: req.flash(
        'message',
        `Un lien de connexion a été envoyé à l'adresse ${emailInput}. Il est valable une heure.`
      ),
    });
  } catch (err) {
    console.error(err);

    req.flash('error', err.message);
    return res.redirect(`/login${nextParam}`);
  }
}
