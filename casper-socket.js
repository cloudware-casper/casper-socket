/*
  - Copyright (c) 2014-2016 Cloudware S.A. All rights reserved.
  -
  - This file is part of casper-socket.
  -
  - casper-socket is free software: you can redistribute it and/or modify
  - it under the terms of the GNU Affero General Public License as published by
  - the Free Software Foundation, either version 3 of the License, or
  - (at your option) any later version.
  -
  - casper-socket  is distributed in the hope that it will be useful,
  - but WITHOUT ANY WARRANTY; without even the implied warranty of
  - MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  - GNU General Public License for more details.
  -
  - You should have received a copy of the GNU Affero General Public License
  - along with casper-socket.  If not, see <http://www.gnu.org/licenses/>.
  -
 */

import { PolymerElement } from '@polymer/polymer/polymer-element.js';

// from https://stackoverflow.com/questions/26150232/resolve-javascript-promise-outside-function-scope
class CasperSocketPromise
{
  constructor () {
    this._promise = new Promise((resolve, reject) => {
      // assign the resolve and reject functions to `this`
      // making them usable on the class instance
      this.resolve = resolve;
      this.reject = reject;
    });
    // bind `then` and `catch` to implement the same interface as Promise
    this.then  = this._promise.then.bind(this._promise);
    this.catch = this._promise.catch.bind(this._promise);
    this[Symbol.toStringTag] = 'Promise';
  }
}

class CasperSocket extends PolymerElement {

  static get is () {
    return 'casper-socket';
  }

  static get properties () {
    return {
      /** websocket schema + hostname (no port no path) */
      url: {
        type: String
      },
      /** websocket port number, defaults to current page port */
      port: {
        type: String
      },
      /** Path or route that connects to casper-epaper module */
      path: {
        type: String
      },
      /** Sec-WebSocket-Protocol */
      webSocketProtocol: {
        type: String,
        value:  'casper-epaper'
      },
      /** Tube prefix */
      tubePrefix: {
        type: String,
        value: 'casper',
        observer: '_onTubePrefixChanged'
      },
      /** Define to use cookies valid for all sub domains of this domain */
      cookieDomain: {
        type: String,
        value: undefined
      },
      /** Default timeout for server requests in seconds */
      defaultTimeout: {
        type: Number,
        value: 10
      },
      /** Time the web socket is kept open after the user becomes idle, must be less than sessionRenewTolerance */
      userIdleTimeout: {
        type: Number,
        value: 20
      },
      /** Lower limit for session time to live, when the ttl gets bellow this the session will be refreshed */
      sessionRenewTolerance: {
        type: Number,
        value: 3500
      }
    }
  }

  /**
   * @brief Assign defaults to undefined component attributes
   */
  constructor () {
    super();
    if ( this.url === undefined ) {
      if ( window.location.protocol === 'https:' ) {
        this.url = 'wss://' + window.location.hostname;
      } else {
        this.url = 'ws://' + window.location.hostname;
      }
    }
    this.port = this.port || window.location.port;
    this.path = this.path || 'epaper';

    if ( this.cookieDomain === undefined ) {
      let domain = window.location.hostname.split('.');
      if (domain.length >= 3 ) {
        domain.shift();
      }
      this.cookieDomain = domain.join('.');
    }

    this._boundMouseOutListener    = this._mouseOutListener.bind(this);
    this._boundUserActivity        = this.userActivity.bind(this);
    this._boundApplicationInactive = this.applicationInactive.bind(this);
  }

  connectedCallback () {
    this._initData();
    this._silentDisconnect = false;
    this._socket           = undefined;

    // ... install global listeners to detect user activity
    document.addEventListener('mouseout', this._boundMouseOutListener);
    //document.addEventListener('click',    this._boundUserActivity);
    document.addEventListener('keypress', this._boundUserActivity);
    window.addEventListener('blur',       this._boundApplicationInactive);
  }

  _mouseOutListener (event) {
    if (event.toElement == null && event.relatedTarget == null) {
      this.applicationInactive(event);
    }
  }

  disconnectedCallback () {
    this._clearData();
    this.disconnect();

    // ... cleanup global listeners
    document.removeEventListener('mouseout', this._boundMouseOutListener);
    //document.removeEventListener('click',    this._boundUserActivity);
    document.removeEventListener('keypress', this._boundUserActivity);
    window.removeEventListener('blur',       this._boundApplicationInactive);
  }

  connect () {
    this._ws_url = this.url + ((this.port != undefined && this.port !== '') ? ':' + this.port : '') + '/' + this.path;
    if (typeof MozWebSocket != "undefined") {
      this._socket = new MozWebSocket(this._ws_url, this.webSocketProtocol);
    } else {
      this._socket = new WebSocket(this._ws_url, this.webSocketProtocol);
    }
    this._socket.onmessage = this._onSocketMessage.bind(this);
    this._socket.onopen    = this._onSocketOpen.bind(this);
    this._socket.onclose   = this._onSocketClose.bind(this);
  }

  /**
   * Terminate connection to casper server
   */
  disconnect () {
    this._clearData();
    if ( this._socket ) {
      this._socket.close();
      this._socket = undefined;
    }
  }

  isOpen () {
    if ( this._socket === undefined ) {
      return false;
    } else {
      return this._socket.readyState === 1;
    }
  }

  submitJob (job, handler, options) {
    let timeout;

    // .. set all keys that will be automatically replaced with session values
    job['user_id']          = null;
    job['entity_id']        = null;
    job['entity_schema']    = null;
    job['sharded_schema']   = null;
    job['subentity_id']     = null;
    job['subentity_schema'] = null;
    job['subentity_prefix'] = null;
    job['user_email']       = null;
    if ( options != undefined && options.ttr ) {
      job['ttr']             = options.ttr;
    }

    if ( this.extraOptions !== undefined ) {
      this.extraOptions.forEach((elem) => {
        job[elem.key] = elem.value;
      });
    }

    let target  = {target: 'job-queue', tube: job.tube};
    if ( options ) {
      if ( options.ttr !== undefined ) {
        target.ttr = options.ttr;
      }
      if ( options.validity ) {
        target.validity = options.validity;
      }
      timeout = options.timeout;
      if ( options.overlay ) {
        this._showOverlay(options.overlay);
      }
    }
    timeout = timeout || this.defaultTimeout;
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), timeout * 1000);
    let request = { job: job, callback: this._submitJobResponse.bind(this), options: options, handler: handler, invokeId: ivk, timer: tid };
    this._send(ivk + ':PUT:' + JSON.stringify(target)+':'+JSON.stringify(job));
    this._activeRequests.set(ivk, request);
  }

  _submitJobResponse (response, request, subscribe) {
    if ( response.success === true && response.channel ) {
      request.channel = response.channel;
      if ( subscribe ) {
        this._subscriptions.set(response.channel, { handler: request.handler, timer: request.timer, invokeId: request.invokeId, confirmed: true, job: true });
      }
      if ( request.handler !== undefined && response.status_code !== undefined && response.status !== undefined ) {
        request.handler(response);
      }
    } else {
      request.handler({
          message: ['O servidor recusou o pedido, p.f. tente mais tarde'],
          status: 'error',
          status_code: 500
        });
    }
  }

  subscribeJob (jobId, handler, timeout) {
    let p = jobId.split(':');
    timeout = timeout || this.defaultTimeout;
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), timeout * 1000);
    let request = { tube: p[0], id: p[1], callback: this._subscribeJobResponse.bind(this), handler: handler, invokeId: ivk, timer: tid };
    this._send(ivk + ':SUBSCRIBE:' + JSON.stringify({ target: 'job', tube: request.tube, id: request.id }));
    this._activeRequests.set(ivk, request);
  }

  _subscribeJobResponse (response, request, subscribe) {
    if ( response.success === true && response.channel ) {
      request.channel = response.channel;
      if ( request.handler !== undefined && response.status !== undefined ) { // Note persistent jobs don't send status_code, don't test it
        request.handler(response);
      }
      if ( subscribe ) {
        this._subscriptions.set(response.channel, { handler: request.handler, timer: request.timer, invokeId: request.invokeId, confirmed: true });
      }
    } else {
      request.handler({
          message: ['O servidor recusou o pedido, p.f. tente mais tarde'],
          status: 'error',
          status_code: 500
        });
    }
  }

  cancelJob (jobChannel, callback) {
    let subscription = this._subscriptions.get(jobChannel);
    if ( subscription ) {
      clearTimeout(subscription.timer);
      this._subscriptions.delete(jobChannel);
    }
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), this.defaultTimeout * 1000);
    let p = jobChannel.split(':');
    let request = { tube: p[0], id: p[1], callback: callback, timer: tid, invokeId: ivk };
    this._send(ivk + ':CANCEL:' + JSON.stringify({ target: 'job-queue', tube: request.tube, id: request.id }));
    this._activeRequests.set(ivk, request);
  }

  //***************************************************************************************//
  //                                                                                       //
  //                            ~~~ Login and Logout ~~~                                   //
  //                                                                                       //
  //***************************************************************************************//

  loginListener (notification) {
    try {
      if ( notification.status === 'completed' && notification.status_code === 200 ) {
        this.saveSessionCookie(notification.response.access_token, notification.response.access_ttl, notification.response.issuer_url);
        this._silentDisconnect = true;
        this.disconnect();
        if ( notification.response.url !== undefined ) {
          window.location = notification.response.url;
        }
      } else if ( notification.status === 'error' ) {
        if ( notification.status_code === 401 ) {
          this.dispatchEvent(new CustomEvent('casper-forbidden', {bubbles: true, composed: true, detail: { message: notification.message }}));
        } else {
          this.dispatchEvent(new CustomEvent('casper-error', {bubbles: true, composed: true, detail: { message: notification.message }}));
        }
      }
    } catch (exception) {
      console.log(exception);
      this.dispatchEvent(new CustomEvent('casper-error', {bubbles: true, composed: true, detail: { message: notification.message }}));
    } finally {
      this.disconnect();
    }
  }

  signOut () {
    let failed = false;

    try {
      if ( this.sessionCookie ) {
            this.submitJob({
            tube:          this._logoutQueue,
            access_token:  null,
            refresh_token: null
          },
          this._signOutResponse.bind(this), {
            ttr: 90,
            validity: 120
          }
        );
      }
    } catch (exception) {
      // ... ignore and proceed with the the logout
      failed = true;
    } finally {
      this.wipeCredentials();
    }
    if ( failed ) {
      this.dispatchEvent(new CustomEvent('casper-signed-out', {bubbles: true, composed: true}));
    }
  }

  _signOutResponse (response) {
    this.dispatchEvent(new CustomEvent('casper-signed-out', {bubbles: true, composed: true}));
    this.disconnect();
    window.location = '/login';
  }

  /**
   * Validate the current access token, retrieve access token (session) from cookie and set on websocket
   */
  validateSession () {
    const accessToken = this.sessionCookie;

    if ( accessToken ) {
      this._setSession(accessToken, this._validateSessionResponse.bind(this));
    } else {
      this.deleteSessionCookie();
      this.dispatchEvent(new CustomEvent('casper-signed-out', {bubbles: true, composed: true}));
    }
  }

  /**
   * Send the command that sets the current session on the casper server websocket context
   *
   * @param {String}   accessToken the session identifier
   * @param {Function} callback function that will be called (bound to receiver)
   */
  _setSession (accessToken, callback) {
    this._showOverlay({message: 'Validação de sessão em curso', icon: 'connecting', spinner: true, loading_icon: 'loading-icon-03'});
    this._accessToken = accessToken;
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), this.defaultTimeout * 1000);
    let request = { access_token: accessToken, callback: callback, invokeId: ivk, timer: tid };
    this._send(ivk + ':SET:{"target":"session"}:' + JSON.stringify(request));
    this._activeRequests.set(ivk, request);
  }

  /**
   * Handle the set session response returned by the server
   *
   * @param {object} response the server response to the set session command
   */
  _validateSessionResponse (response) {
    if ( response.success === false ) {
      this._accessToken = undefined;
      this.deleteSessionCookie();
      this.dispatchEvent(new CustomEvent('casper-signed-out', { bubbles: true, composed: true }));
    } else {
      if ( response.refresh_token ) {
        window.localStorage.setItem('casper-refresh-token', response.refresh_token);
      } else {
        window.localStorage.removeItem('casper-refresh-token');
      }
      if ( response.entity_id ) {
        window.localStorage.setItem('casper-last-entity-id', response.entity_id);
        this._manageNotifications(response.entity_id);
      }
      if ( response.user_email ) {
        this.savedEmail = response.user_email;
      }
      this._accessValidity = this.sessionValidity; // read back from cookie
      this._startIdleTimer();
      this.dispatchEvent(new CustomEvent('casper-signed-in', { bubbles: true, composed: true, detail: response }));
    }
  }

  _manageNotifications (entity_id) {
    if ( this._subscriptions ) {
      this._subscriptions.forEach(function(subscription, key, map) {
        if ( subscription.notification && subscription.confirmed ) {
          let a = key.split(':');

          if ( a[0] === 'company' ) {
            if ( a[1] == entity_id && subscription.handler ) {
              this.subscribeNotifications(a[0], a[1], subscription.handler);
            } else {
              this._unsubscribeNotifications(a[0], a[1]);
            }
          } else {
            this.subscribeNotifications(a[0], a[1], subscription.handler);
          }
        }
      }.bind(this));
    }
  }

  extendSession () {
    this.submitJob({
        tube:          this.extendTube,
        access_token:  null
      },
      this._extendSessionResponse.bind(this), {
        ttr: Math.max(this.defaultTimeout - 5, 5),
        validity: this.defaultTimeout,
        timeout: this.defaultTimeout,
        overlay: {
          message: 'Renovação sessão iniciada',
          icon:'connecting',
          spinner: true,
          loading_icon: 'loading-icon-03'
        }
      }
    );
  }

  _extendSessionResponse (response) {
    if ( response.status_code !== 200 || (response.success !== undefined && response.success !== true) ) {
      window.location = '/login';
    } else if ( response.status === 'completed' && response.status_code === 200 ) {
      if ( response.response === undefined ) {
        window.location = '/login';
      } else {
        this._accessToken = response.response.access_token;
        this.saveSessionCookie(response.response.access_token, response.response.access_ttl, response.response.issuer_url);
        this.validateSession();
      }
    }
  }

  //***************************************************************************************//
  //                                                                                       //
  //                              ~~~ Entity switching ~~~                                 //
  //                                                                                       //
  //***************************************************************************************//

  switchToEntity (entityId, redirectUrl, subEntityId, subEntityType) {
    this.submitJob({
        tube:               this._switchEntityQueue,
        access_token:       null,             // will be set by server from session data
        refresh_token:      null,             // will be set by server from session data
        to_entity_id:       entityId,         // id of the entity we'll switch to
        to_subentity_id:    subEntityId,      // id of the sub-entity we'll switch to
        to_subtype:         subEntityType,    // type of the sub-entity we'll switch to
        url:                redirectUrl       // URL to load after the switch is made
      },
      this._switchEntityListener.bind(this), {
        ttr: Math.max(this.defaultTimeout - 5, 5),
        validity: this.defaultTimeout,
        timeout: this.defaultTimeout,
        overlay: {
          message: 'A mudar de empresa',
          spinner: true,
          icon: 'switch'
        }
      }
    );
  }

  _switchEntityListener (notification) {
    if ( notification.status === 'completed' && notification.status_code === 200 ) {
      if ( notification.response.url[0] === '/' ) {
        // ... we are on the same cluster ...
        this._switchResponse = notification.response;
        this._setSession(notification.response.access_token, this._validateSwitchSessionResponse.bind(this));
      } else {
        // ... we moved to another cluster ...
        this.saveSessionCookie(notification.response.access_token, notification.response.access_ttl, notification.response.issuer_url);
        if ( notification.response.url !== undefined ) {
          window.location = notification.response.url;
        }
      }
    } else {
      this._showOverlay({message: 'Falha na mudança de empresa', icon: 'error' });
    }
  }

  _validateSwitchSessionResponse (response) {
    if ( response.success === false ) {
      this.deleteSessionCookie();
      this.dispatchEvent(new CustomEvent('casper-signed-out', {bubbles: true, composed: true}));
    } else {
      if ( this._switchResponse !== undefined ) {
        this._accessToken    = this._switchResponse.access_token;
        this._accessValidity = (new Date().valueOf())/ 1000 + this._switchResponse.access_ttl; // same value saved on casper-validity cookie
        this.saveSessionCookie(this._switchResponse.access_token, this._switchResponse.access_ttl, this._switchResponse.issuer_url);
        if ( this._switchResponse.user_email ) {
          this.savedEmail = this._switchResponse.user_email;
        }
        if ( response.refresh_token ) {
          window.localStorage.setItem('casper-refresh-token', response.refresh_token);
        } else {
          window.localStorage.removeItem('casper-refresh-token');
        }
        if ( response.entity_id ) {
          window.localStorage.setItem('casper-last-entity-id', response.entity_id);
          this._manageNotifications(response.entity_id);
        }
      }
      response.url = this._switchResponse.url;
      this._startIdleTimer();
      this.dispatchEvent(new CustomEvent('casper-signed-in', {
          bubbles: true,
          composed: true,
          detail: response
        })
      );
    }
    this._switchResponse = undefined;
  }

  switchToSubEntity (subEntityType, subEntityId, redirectUrl) {
    this.submitJob({
        tube:            this._switchSubEntityQueue,
        access_token:    null,             // will be set by server from session data
        refresh_token:   null,             // will be set by server from session data
        url:             redirectUrl,      // URL to load after the switch is made
        to_subtype:      subEntityType,    // Subentity type
        to_subentity_id: subEntityId       // Subentity identifier
      },
      this._switchEntityListener.bind(this), {
        ttr: 60,
        validity: 70,
        timeout: 10,
        overlay: {
          message: 'A mudar ano fiscal',
          spinner: true,
          icon: 'switch'
        }
      }
    );
  }

  //***************************************************************************************//
  //                                                                                       //
  //                               ~~~ Documents ~~~                                       //
  //                                                                                       //
  //***************************************************************************************//

  /**
   * Open document template
   */
  openDocument (chapterModel, clientCallback, documentHandler) {
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), this.defaultTimeout * 1000);
    let request = { timer: tid, invokeId: ivk, callback: function (response) {
                                if ( undefined != response.id ) {
                                  this._documents.set(response.id, documentHandler);
                                }
                                this._dismissOverlay();
                                clientCallback(response);
                              }.bind(this) };
    let options = { target: "document" }

    // Check if there is a software notice stored in session.
    const socketPayload = Object.assign({}, chapterModel);
    if (app.session_data.app.hasOwnProperty('certified_software_notice')) {
      socketPayload.overridable_system_variables = {
        CERTIFIED_SOFTWARE_NOTICE: app.session_data.app.certified_software_notice
      };
    }

    this._send(ivk + ':OPEN:' + JSON.stringify(options) + ':' + JSON.stringify(socketPayload));
    this._activeRequests.set(ivk, request);

    this._showOverlay({message: 'A carregar modelo do documento', icon: 'connecting', spinner: true, loading_icon: 'loading-icon-03'});
    this.userActivity();
  }

  loadDocument (chapterModel, clientCallback) {
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), this.defaultTimeout * 1000);
    let request = { timer: tid, invokeId: ivk, callback: function (response) {
                                this._dismissOverlay();
                                clientCallback(response);
                              }.bind(this) };
    let options = { target: "document", id: chapterModel.id }

    this._send(ivk + ':LOAD:' + JSON.stringify(options) + ':' + JSON.stringify(chapterModel));
    this._activeRequests.set(ivk, request);

    this._showOverlay({message: 'A carregar dados do documento', icon: 'connecting', spinner: true, loading_icon: 'loading-icon-03'});
    this.userActivity();
  }

  reloadDocument (id, callback) {
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), this.defaultTimeout * 1000);
    let request = { callback: callback, timer: tid, invokeId: ivk };
    let options = { target: "document", id: id }
    this._send(ivk + ':RELOAD:' + JSON.stringify(options));
    this._activeRequests.set(ivk, request);
    this.userActivity();
  }

  closeDocument (id, reload, callback) {
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), this.defaultTimeout * 1000);
    let request = { callback: callback, timer: tid, invokeId: ivk };
    let options;
    if ( undefined != id ) {
      options = { target: "document", id: id }
    } else {
      options = { target: "document" }
    }
    if ( reload !== undefined && reload === false ) {
      options.reload = false;
    }
    this._send(ivk + ':CLOSE:' + JSON.stringify(options));
    this._activeRequests.set(ivk, request);
  }

  sendKey (id, key, modifier, callback) {
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), this.defaultTimeout * 1000);
    let request = { callback: callback, timer: tid, invokeId: ivk };
    let options = { target: "document", id: id };
    let command = { input: { key: key }};
    if ( modifier ) {
      command.input.modifier = modifier;
    }
    this._send(ivk + ':SET:' + JSON.stringify(options) + ':' + JSON.stringify(command));
    this._activeRequests.set(ivk, request);
    this.userActivity();
  }

  moveCursor (id, motion, callback) {
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), this.defaultTimeout * 1000);
    let request = { callback: callback, timer: tid, invokeId: ivk };
    let options = { target: "document", id: id };
    let command = { input: { motion: motion }};
    this._send(ivk + ':SET:' + JSON.stringify(options) + ':' + JSON.stringify(command));
    this._activeRequests.set(ivk, request);
    this.userActivity();
  }

  setText (id, value, motion, callback) {
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), this.defaultTimeout * 1000);
    let request = { callback: callback, timer: tid, invokeId: ivk };
    let options = { target: "document", id: id };
    let command = { input: { text: value }};
    if ( motion ) {
      command.input.motion = motion;
    }
    this._send(ivk + ':SET:' + JSON.stringify(options) + ':' + JSON.stringify(command));
    this._activeRequests.set(ivk, request);
    this.userActivity();
  }

  setTextT (id, value, motion, final, callback) {
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), this.defaultTimeout * 1000);
    let request = { callback: callback, timer: tid, invokeId: ivk };
    let options = { target: "document", id: id };
    let command = { input: { text: value, final_update: final }};
    if ( motion ) {
      command.input.motion = motion;
    }
    this._send(ivk + ':SET:' + JSON.stringify(options) + ':' + JSON.stringify(command));
    this._activeRequests.set(ivk, request);
    this.userActivity();
  }

  sendClick (id, x, y, callback) {
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), this.defaultTimeout * 1000);
    let options = { target: "document", id: id };
    let command = { input: { click: { x: x, y: y }}};
    let request = { callback: callback, timer: tid, invokeId: ivk };
    this._send(ivk + ':SET:' + JSON.stringify(options) + ':' + JSON.stringify(command));
    this._activeRequests.set(ivk, request);
    this.userActivity();
  }

  gotoPage (id, pageNumber, focus, callback) {  // focus???
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), this.defaultTimeout * 1000);
    let options = { target: "document", id: id };
    let command = { properties: { page: pageNumber }};
    let request = { callback: callback, timer: tid, invokeId: ivk };
    this._send(ivk + ':SET:' + JSON.stringify(options) + ':' + JSON.stringify(command));
    this._activeRequests.set(ivk, request);
    this.userActivity();
  }

  setScale (id, scale, callback) {
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), this.defaultTimeout * 1000);
    let options = { target: "document", id: id };
    let command = { properties: { scale: scale }};
    let request = { callback: callback, timer: tid, invokeId: ivk };
    this._send(ivk + ':SET:' + JSON.stringify(options) + ':' + JSON.stringify(command));
    this._activeRequests.set(ivk, request);
  }

  setEditable (id, editable, callback) {
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), this.defaultTimeout * 1000);
    let options = { target: "document", id: id };
    let command = { properties: { editable: editable }};
    let request = { callback: callback, timer: tid, invokeId: ivk };
    this._send(ivk + ':SET:' + JSON.stringify(options) + ':' + JSON.stringify(command));
    this._activeRequests.set(ivk, request);
  }

  setListValue (id, value, callback) {
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), this.defaultTimeout * 1000);
    let options = { target: "document", id: id };
    let command = { input: { text: value, key: 'save' }};
    let request = { callback: callback, timer: tid, invokeId: ivk };
    this._send(ivk + ':SET:' + JSON.stringify(options) + ':' + JSON.stringify(command));
    this._activeRequests.set(ivk, request);
    this.userActivity();
  }

  getNotifications (channel, callback) {
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), this.defaultTimeout * 1000);
    let request = { invokeId: ivk, timer: tid, callback: function (response) {
           try {
             let notifications = [];
             for ( var m of response.members ) {
               notifications.push(JSON.parse(m));
             }
             callback(notifications);
           } catch (e) {
             callback([]);
           }
         }.bind(this)
      };
    let options = { target: 'notifications', channel: channel };
    this._send(ivk + ':GET:' + JSON.stringify(options));
    this._activeRequests.set(ivk, request);
  }

  subscribeNotifications (channel, id, handler) {
    let ivk = this._selectInvokeId();
    let chn = channel + ':' + id;
    let tid = setTimeout(() => this._timeoutHandler(ivk), this.defaultTimeout * 1000);
    let request = { callback: this._subscribeNotificationsResponse.bind(this), channel: chn, handler: handler, timer: tid, invokeId: ivk };
    this._send(ivk + ':SUBSCRIBE:' + JSON.stringify({ target: 'notifications', channel: channel, id: id }));
    this._activeRequests.set(ivk, request);
    this._subscriptions.set(channel + ':' + id, { handler: handler, timer: tid, invokeId: ivk, confirmed: false, notification: true});
  }

  _subscribeNotificationsResponse (response, request) {
    let subscription = undefined;

    if ( request.channel ) {
      subscription = this._subscriptions.get(request.channel);
      if ( subscription ) {
        if ( response.success === true ) {
          subscription.timer     = undefined;
          subscription.invokeId  = undefined;
          subscription.confirmed = true;
          return;
        }
      }
    }
    // cleanup
    if ( subscription ) {
      if ( subscription.handler ) {
        subscription.handler("failed"); // TODO normalize response
      }
      this._subscriptions.delete(request.channel);
    }
  }

  _unsubscribeNotifications (channel, id) {
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), this.defaultTimeout * 1000);
    let request = { timer: tid, invokeId: ivk };
    this._send(ivk + ':UNSUBSCRIBE:' + JSON.stringify({ target: 'notifications', channel: channel, id: id }));
    this._activeRequests.set(ivk, request);
  }

  getData (urn, timeout, callback) {
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), (timeout || this.defaultTimeout) * 1000);
    let options = { target: "jsonapi", urn: urn };
    let request = { callback: callback, timer: tid, invokeId: ivk  };
    this._send(ivk + ':GET:' + JSON.stringify(options));
    this._activeRequests.set(ivk, request);

    return ivk;
  }

  /**
   * Requests the server side hint for the current hovering point
   *
   * @param {number} id document identifier
   * @param {number} x coordinate where the mouse is overing
   * @param {number} y coordinate where the mouse is overing
   * @param {function} bound response handler to callback
   */
  getHint (id, x, y, callback) {
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), this.defaultTimeout * 1000);
    let options = { target: "document", id: id };
    let command = { hint: { x: 1.0 * x.toFixed(2), y: 1.0 * y.toFixed(2) }};
    let request = { callback: callback, timer: tid, invokeId: ivk  };
    this._send(ivk + ':GET:' + JSON.stringify(options) + ':' + JSON.stringify(command));
    this._activeRequests.set(ivk, request);
    this.userActivity();
  }

  addBand (id, type, bandId, callback) {
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), this.defaultTimeout * 1000);
    let options = { target: "document", id: id };
    let command = { band: { type: type, id: bandId}};
    let request = { callback: callback, timer: tid, invokeId: ivk };
    this._send(ivk + ':ADD:' + JSON.stringify(options) + ':' + JSON.stringify(command));
    this._activeRequests.set(ivk, request);
  }

  deleteBand (id, type, bandId, callback) {
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), this.defaultTimeout * 1000);
    let options = { target: "document", id: id };
    let command = { band: { type: type, id: bandId}};
    let request = { callback: callback, timer: tid, invokeId: ivk };
    this._send(ivk + ':REMOVE:' + JSON.stringify(options) + ':' + JSON.stringify(command));
    this._activeRequests.set(ivk, request);
    this.userActivity();
  }

  //***************************************************************************************//
  //                                                                                       //
  //                               ~~~ Internal methods ~~~                                //
  //                                                                                       //
  //***************************************************************************************//

  /**
   * Send text message to casper server
   *
   * @param {String} message the plain text message to send
   */
  _send (message) {
    if ( this._socket === undefined || this._socket.readyState !== 1 ) {
      this._pendingCommands.push(message);
      this.connect();
    } else if (this._socket.readyState === 1 ) {
      this._socket.send(message);
    }
  }

  /**
   * Assigns the next invoke id for communication with the server
   */
  _selectInvokeId () {
    if ( this._freedInvokes.length === 0 ) {
      return this._nextInvokeId++;
    } else {
      return this._freedInvokes.shift();
    }
  }

  _freeInvokeId (invoke) {
    if ( !isNaN(invoke) ) {
      this._freedInvokes.push(invoke);
    } else {
      debugger;
    }
  }

  _onSocketOpen (event) {
    if ( this._pendingCommands.length !== 0 ) {
      for (let message of this._pendingCommands) {
        this._socket.send(message);
      }
      this._pendingCommands = [];
    }
    this.dispatchEvent(new CustomEvent('casper-connected', {bubbles: true, composed: true}));
  }

  _onSocketClose (event) {
    if ( this._silentDisconnect !== true ) {
      // this.dispatchEvent(new CustomEvent('casper-disconnected', {bubbles: true, composed: true, detail: { message: 'casper-disconnected', icon: 'sleep'} }));
      this.dispatchEvent(new CustomEvent('casper-disconnected', {bubbles: true, composed: true, detail: { message: '', icon: 'sleep'} }));
    } else {
      this.dispatchEvent(new CustomEvent('casper-disconnected', {bubbles: true, composed: true, detail: { silent: true } }));
    }
    this._silentDisconnect = false;
    this._socket = undefined;
  }

  /**
   * Message decoder and handler, decodes the JSON payloads and delivers the message to the clients
   *
   * @param {Object} message the web socket message
   */
  _onSocketMessage (message) {
    try {
      let request, payload, invokeId, timerId, releaseInvoke = true;

      let data  = message.data;
      const start = data.indexOf('0:N:{');
      if ( start === 0 ) {
        const end = data.indexOf('"}:{"');
        if ( -1 !== end ) {
          const channel = data.substring(16,end);
          const notification = JSON.parse(data.substring(end+3));
          const subscription = this._subscriptions.get(channel);

          if ( subscription ) {
            timerId = subscription.timer;
            if ( timerId ) {
              if ( notification.status !== 'in-progress' ) {

                let request = this._activeRequests.get(subscription.invokeId);
                if ( request ) {
                  if ( request.options && request.options.overlay ) {
                    if ( notification.status === 'error') {
                      this._showOverlay({ message: notification.message[0], icon: 'error' });
                    } else if ( notification.status === 'completed' ) {
                      this._dismissOverlay();
                    }
                  }
                  this._activeRequests.delete(invokeId);
                }
                clearTimeout(timerId);
                this._subscriptions.delete(channel);
                this._freeInvokeId(subscription.invokeId);
              }
              if (subscription.confirmed && subscription.handler) {
                subscription.handler(notification);
              } else {
                console.log("**** subscription no longer active:", channel);
              }
            } else {
              if ( subscription.confirmed && subscription.notification && subscription.handler ) {
                console.warn('This a real notification ', channel);
                subscription.handler(notification);
              } else {
                console.warn('**** subscription no longer active: ' + channel);
              }
            }
          } else {
            console.warn("**** subscription no longer active:", channel);
          }
        } else {
          console.error("Yikes! Protocol decoding error");
        }
        return;
      }

      invokeId = parseInt(data);
      if ( !isNaN(invokeId) ) {
        const offset = invokeId.toString().length;
        if ( data.substring(offset, offset+ 3) === ':D:' || data.substring(offset, offset+3) === ':n:') {
          const documentHandler = this._documents.get(invokeId);
          if ( documentHandler ) {
            documentHandler(data.substring(offset+1));
          }
        } else {
          request = this._activeRequests.get(invokeId);
          if ( request !== undefined ) {
            let payload_start, subscribe;

            timerId = request.timer;
            if ( (payload_start = data.indexOf(':R:{')) === offset ) {
              payload = JSON.parse(data.substring(payload_start + 3));
            } else if ((payload_start = data.indexOf(':S:{')) === offset) {
              payload = JSON.parse(data.substring(payload_start + 3));
            } else if ((payload_start = data.indexOf(':E:{')) === offset) {
              payload = JSON.parse(data.substring(payload_start + 3));
            } else if ((payload_start = data.indexOf(':H:')) === offset ) {
              let response    = data.substring(payload_start + 3);
              let status_code = parseInt(response);
              response = response.substring(response.indexOf(':') + 1);
              if ( response.length ) {
                payload = JSON.parse(response);
              }
              if ( status_code >= 100 && status_code < 299 ) {
                request.promise.resolve(payload);
              } else {
                request.promise.reject(payload !== undefined ? new Error(payload.error) : Error("Unknown error"));
              }
              clearTimeout(timerId);
              this._activeRequests.delete(invokeId);
              this._freeInvokeId(invokeId);
              return;
            } else {
              // Unknown message ignore
              console.error('casper protocol decoding error!!!');
            }
            if ( ! (payload.channel && timerId && ( !payload.status || ['in-progress', 'queued'].includes(payload.status.status) ))) {
              // ... release the invoke ...
              if ( timerId ) {
                clearTimeout(timerId);
              }
              this._activeRequests.delete(invokeId);
              this._freeInvokeId(invokeId);
              subscribe = false;
            } else {
              if ( false ) {
                console.log(`keeping invoke ${invokeId} alive for channel ${payload.channel}`);
              }
              subscribe = true;
            }

            if ( payload && request.callback !== undefined ) {
              request.callback(payload, request, subscribe);
              return;
            }
          } else {
            this._freeInvokeId(invokeId);
          }
        }
      }
    } catch (exception) {
      console.log(exception);
    }
    return;
  }

  /**
   * Handle request timeouts
   *
   * @param {Integer} invokeId the invoke identifier associated with the original request
   */
  _timeoutHandler (invokeId) {
    let handled = false;

    console.warn("**** Timeout for invoke ", invokeId);

    const request = this._activeRequests.get(invokeId);
    if ( request !== undefined ) {
      if ( request.channel ) {
        let subscription = this._subscriptions.get(request.channel);
        if ( subscription && subscription.job === true && subscription.confirmed === true ) {
          if ( window.app && window.app.wizard && window.app.wizard.channel === request.channel ) {
            handled = true;
            this._startIdleTimer();
          }
        }
        this._subscriptions.delete(request.channel);
      }
      if ( request.handler !== undefined ) {
        request.handler({
          message: ['Tempo de espera ultrapassado'],
          status: 'error',
          status_code: 504
        });
      }
      if ( request.promise !== undefined ) {
        request.promise.reject(new Error('HTTP bridge Timeout'));
      }
      this._activeRequests.delete(invokeId);
      this._freeInvokeId(invokeId);
    }
    if ( ! handled ) {
      this._showOverlay({ message: 'Tempo de espera ultrapassado', icon: 'timeout' });
    }
  }

  /**
   * Clears timers and internal data
   */
  _clearData () {
    for ( let request of this._activeRequests.values() ) {
      if ( request.timer ) {
        clearTimeout(request.timer);
      }
    }
    this._activeRequests.clear();
    this._documents.clear();
    this._subscriptions.forEach(function (subscription, channel, subs) {
      if ( ! (subscription.notification && subscription.confirmed) ) {
        map.delete(key);
      }
    });
    this._initData(false);
  }

  /**
   * Initializes internal data structures
   */
  _initData (clearSubs) {
    this._savedEmail           = undefined;  // The email used to sign-in
    this._accessToken          = undefined;  // The current access token in use
    this._accessValidity       = undefined;  // Last second of session validity in EPOCH (approximation)
    this._pendingCommands      = [];         // Commands waiting for session establishment
    this._freedInvokes         = [];         // keeps the invokes that were returned by the server
    this._activeRequests       = new Map();  // hash, key is the Invoke value the request in flight
    this._documents            = new Map();
    this._nextInvokeId         = 1;          // The next fresh invoke ID
    if ( this._subscriptions === undefined || clearSubs === true ) {
      this._subscriptions = new Map();      // Registry of server subscriptions, key is channel
    }
    this._applicationInactive  = false;
  }

  /**
   * Observer to initialize the beanstalkd tube names
   */
  _onTubePrefixChanged () {
    this.loginTube             = this.tubePrefix + '-login';
    this.refreshTube           = this.tubePrefix + '-token-refresh';
    this.extendTube            = this.tubePrefix + '-session-extend';
    this._switchEntityQueue    = this.tubePrefix + '-switch-entity';
    this._switchSubEntityQueue = this.tubePrefix + '-switch-subentity';
    this._logoutQueue          = this.tubePrefix + '-logout';
  }

  /**
   * Helper to bring the overlay that blocks the user interface
   *
   * @param {Object} detail
   */
  _showOverlay (detail) {
    this.dispatchEvent(new CustomEvent('casper-show-overlay', {
        bubbles: true,
        composed: true,
        detail: detail
      })
    );
   }

  /**
   * Helper to dismiss the overlay that blocks the user interface
   */
  _dismissOverlay () {
    this.dispatchEvent(new CustomEvent('casper-dismiss-overlay', {
        bubbles: true,
        composed: true
      })
    );
  }

  /**
   * This method should be called whenever the user does a click or presses a key.
   *
   * @param {Object} The event created by user activity (ignored)
   */
  userActivity (event) {
    if ( this._applicationInactive === true ) {
      this._applicationInactive = false;
      this.checkIfSessionChanged();
    }
    this._startIdleTimer();
    if ( this._accessValidity !== undefined ) {

      let now = new Date().valueOf()/1000;
      if ( false ) {
        console.log('TTL is ~', this._accessValidity - now );
      }
      if ( this._accessValidity - now < this.sessionRenewTolerance ) {
        this.extendSession();
        this._accessValidity = undefined;
      }
    }
  }

  /**
   * This method should be called when window becomes inactive, un-blurred or mouse goes out
   *
   * @param {Object} The event created by user activity
   */
  applicationInactive (event) {
    this.checkIfSessionChanged();
    this._applicationInactive = true;
    this._startIdleTimer();
  }

  /**
   * Initiate or restart the idle timer that suspends the session on user inactivity
   */
  _startIdleTimer () {
    clearTimeout(this._idleTimerId);
    this._idleTimerId = setTimeout(e => this._userIdleTimeout(e), this.userIdleTimeout * 1000);
  }

  /**
   * Handler for user inactivity timeout
   *
   * @note Suspension is prevented when a wizard is opened or generally speaking a server job is pending
   */
  _userIdleTimeout (event) {
    for ( let subscription of this._subscriptions.values() ) {
      if ( subscription.confirmed === true && subscription.job === true ) {
        console.warn('refusing to go idle because at least one job subscription is active');
        return;
      }
    }
    this._applicationInactive = true;
    this._showOverlay({message: 'Sessão suspensa por inatividade', icon: 'cloud', opacity: 0.15});
    this._silentDisconnect = true;
    this.disconnect();
  }

  /**
   * If the session in memory is not same we have saved in the cookie it means another browser window/tab changed it
   *
   * @note This could mean the user changed the login account or selected another entity,
   *       so the only safe action is to reload the page and start fresh with new session
   */
  checkIfSessionChanged () {
    if (  this._accessToken !== undefined && this._accessToken !== this.sessionCookie ) {
      window.location.reload();
    } else {
      this._startIdleTimer();
    }
  }

  //***************************************************************************************//
  //                                                                                       //
  //                      ~~~ Cookie and local storage handling ~~~                        //
  //                                                                                       //
  //***************************************************************************************//

  saveCookie (name, value, ttl) {
    let cookie = `${name}=${value};path=/`;

    if ( window.location.protocol === 'https:' ) {
      cookie += ';secure=true';
    }
    if ( this.cookieDomain ) {
      cookie += `;domain=${this.cookieDomain}`;
    }
    if ( ttl ) {
      let now = new Date();
      now.setSeconds(now.getSeconds() + ttl);
      cookie += `;expires=${now.toUTCString()}`
    }
    cookie += ';';
    document.cookie = cookie;
  }

  /**
   * Clears a cookie
   */
  deleteCookie (name) {
    let cookie = `${name}=`;
    if ( this.cookieDomain ) {
      cookie += `;domain=${this.cookieDomain}`;
    }
    cookie += ';path=/;expires=Thu, 01 Jan 2018 00:00:01 GMT;'
    document.cookie = cookie;
  }

  /**
   * Save session cookie with the current access token
   *
   * @param {String} accessToken the access token generated by the server
   * @param {Number} ttl Time to live how long the token should live in seconds
   * @param {String} issuer_url the URL of the server that issued the access token
   */
  saveSessionCookie (accessToken, ttl, issuer_url) {
    this.saveCookie('casper_session', accessToken, ttl);
    if ( issuer_url ) {
      this.saveCookie('casper_issuer', issuer_url);
    }
    if ( ttl ) {
      this.saveCookie('casper_validity',  (new Date().valueOf())/ 1000 + ttl, ttl);
    }
  }

  /**
   * Retrieve the session cookie that contains the access token aka casper-session
   */
  get sessionCookie () {
    return CasperSocket.readCookie('casper_session', 64);
  }

  /**
   * Retrieve the URL of the machine that issued the last token
   */
  get issuerUrl () {
    return CasperSocket.readCookie('casper_issuer', 10);
  }

  /**
   * Read back a cookie from the cookie jar
   *
   * @param cookie name of the key
   * @param minLength minimum length of the cookie
   * @return cookie value or undefined if the cookie does not exist or it's too short
   */
  static readCookie (cookie, minLength) {
    let value;
    let jar = document.cookie;
    let start = jar.indexOf(cookie+'=');

    if ( start === -1 ) {
      return undefined;
    } else {
      start += cookie.length + 1;
    }
    let end = jar.indexOf(';', start);
    if ( end === -1 ) {
      value = jar.substring(start,jar.length);
    } else {
      value = jar.substring(start,end);
    }
    if ( minLength === undefined ) {
      return value;
    } else {
      return value.length >= minLength ? value : undefined;
    }
  }

  /**
   * Retrieve the session validity in epoch seconds
   */
  get sessionValidity () {
    let validity = parseInt(CasperSocket.readCookie('casper_validity', 10));
    return validity > 0 ? validity : undefined;
  }

  /**
   * Clears the cookie that contains the access token aka casper-session
   */
  deleteSessionCookie () {
    this.deleteCookie('casper_session');
    this.deleteCookie('casper_validity');
  }

  /**
   *  Wipe stored credentials
   */
  wipeCredentials () {
    this.deleteCookie('casper_issuer');
    this.deleteSessionCookie();
    window.localStorage.removeItem('casper-user-email');
    window.localStorage.removeItem('casper-refresh-token');
  }

  /**
   * Retrieve saved email
   */
  get savedEmail () {
    return this._savedEmail || window.localStorage.getItem('casper-user-email');
  }

  /**
   * Save user email
   */
  set savedEmail (email) {
    if ( this._savedEmail !== email ) {
      window.localStorage.setItem('casper-user-email', email);
      this._savedEmail = email;
    }
  }

  /**
   * Retrieve saved credential
   */
  get savedCredential () {
    return window.localStorage.getItem('casper-refresh-token');
  }

  //***************************************************************************************//
  //                                                                                       //
  //            ~~~ Access to upstream restfull microservices via websocket ~~~            //
  //                                                                                       //
  //***************************************************************************************//

  hget (url, timeout) {
    return this._http_upstream('GET', url, undefined, timeout);
  }

  hput (url, body, timeout) {
    return this._http_upstream('PUT', url, body, timeout);
  }

  hpost (url, body, timeout) {
    return this._http_upstream('POST', url, body, timeout);
  }

  hdelete (url, body, timeout) {
    return this._http_upstream('DELETE', url, body, timeout);
  }

  hpatch (url, body, timeout) {
    return this._http_upstream('PATCH', url, body, timeout);
  }

  _http_upstream (verb, url, body, timeout) {
    let ivk     = this._selectInvokeId();
    let tid     = setTimeout(() => this._timeoutHandler(ivk), (timeout || this.defaultTimeout) * 1000);
    let promise = new CasperSocketPromise((resolve, reject) => { /* empty handler */ });
    let request = { promise: promise, timer: tid, invokeId: ivk };
    this._send(`${ivk}:${verb}:${JSON.stringify({ target: 'http', url: url, headers: { 'content-type': 'application/json', 'accept': 'application/json' }})}${(body !== undefined ? ':' + JSON.stringify(body) : '')}`);
    this._activeRequests.set(ivk, request);
    return promise;
  }

  async test (url) {
    url = url || 'http://toconline.io:3200/cdb/vault/accountant/VIACTTIV';

    try {
      let value = await this.hget(url, 0.2);
      let ok = await window.app.showAlert({
                                            overrideWizardDimensions: {
                                             width: '500px',
                                             height: '250px',
                                           },
                                           message: JSON.stringify(value)
                                         });
      console.log(`user said ${ok}`);
    } catch (err) {
      console.log(err);
    }
  }
}

window.customElements.define(CasperSocket.is, CasperSocket);