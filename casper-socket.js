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

/**
 * This promise wrapper can be resolved outside the caller scope, i.e. we can resolve from the
 * network code that decodes incoming messages
 *
 * from https://stackoverflow.com/questions/26150232/resolve-javascript-promise-outside-function-scope
 */
export class CasperSocketPromise {
  constructor() {
    this._promise = new Promise((resolve, reject) => {
      // assign the resolve and reject functions to `this`
      // making them usable on the class instance
      this.resolve = resolve;
      this.reject = reject;
    });
    // bind `then` and `catch` to implement the same interface as Promise
    this.then = this._promise.then.bind(this._promise);
    this.catch = this._promise.catch.bind(this._promise);
    this[Symbol.toStringTag] = 'Promise';
  }
}

export class CasperSocket extends HTMLElement {

  /**************************************************************/
  /*                  Setters and getters                       */
  /**************************************************************/

  get secondary () {
    return this._secondary;
  }

  static get useLocalStorage () {
    return CasperSocket._useLocalStorage === true;
  }

  set secondary (isSecondary) {
    this._secondary = true;
  }

  set useLocalStorage (useLocalStorage) {
    CasperSocket._useLocalStorage = useLocalStorage;
  }

  get userIdleTimeout () {
    return this._userIdleTimeout;
  }

  set extraOptions (options) {
    this._extraOptions = options;
  }

  /**
   * Connstructor assign defaults to undefined component attributes, grabs values from the elements attributes
   */
  constructor() {
    super();
    this._url = this.getAttribute('url');
    if (!this._url) {
      if (window.location.protocol === 'https:') {
        this._url = 'wss://' + window.location.hostname;
      } else {
        this._url = 'ws://' + window.location.hostname;
      }
    }
    /* websocket port number, defaults to current page port */
    this._port = this.getAttribute('port') || window.location.port;
    /* Path or route that connects to casper-epaper module */
    this._path = this.getAttribute('path') || 'epaper';
    /* Default timeout for server requests in seconds */
    this._defaultTimeout = parseInt(this.getAttribute('default-timeout') || '10');
    /* Time in seconds the web socket is kept open after the user becomes idle, must be less than sessionRenewTolerance */
    this._userIdleTimeout = parseInt(this.getAttribute('user-idle-timeout') || '180');
    /* Lower limit for session time to live, when the ttl gets bellow this the session will be extended */
    this._sessionRenewTolerance = parseInt(this.getAttribute('session-renew-tolerance') || '3600');
    /* Define to use cookies valid for all sub domains of this domain */
    this._cookieDomain = this.getAttribute('cookie-domain');
    if (!this._cookieDomain) {
      let domain = window.location.hostname.split('.');
      if (domain.length >= 3) {
        domain.shift();
      }
      this._cookieDomain = domain.join('.');
    }
    /* Sec-WebSocket-Protocol */
    this._webSocketProtocol = this.getAttribute('web-socket-protocol') || 'casper-epaper';
    /* secondary if set the socket does not send events and will not listen to user activity */
    this._secondary = this.hasAttribute('secondary');

    if (this._secondary === false) {
      this._boundMouseOutListener = this._mouseOutListener.bind(this);
      this._boundUserActivity = this.userActivity.bind(this);
      this._boundApplicationInactive = this.applicationInactive.bind(this);
    }
  }

  connectedCallback () {
    this._initData();
    this._silentDisconnect = false;
    this._socket = undefined;

    if (this._secondary === false) {
      // ... install global listeners to detect user activity
      document.addEventListener('mouseout', this._boundMouseOutListener);
      document.addEventListener('keypress', this._boundUserActivity);
      window.addEventListener('blur', this._boundApplicationInactive);
    }
  }

  _mouseOutListener (event) {
    if (event.toElement == null && event.relatedTarget == null) {
      this.applicationInactive(event);
    }
  }

  disconnectedCallback () {
    this._clearData();
    this.disconnect();

    if (this._secondary === false) {
      // ... cleanup global listeners
      document.removeEventListener('mouseout', this._boundMouseOutListener);
      document.removeEventListener('keypress', this._boundUserActivity);
      window.removeEventListener('blur', this._boundApplicationInactive);
    }
  }

  _connectAsync (url) {
    const promise = new CasperSocketPromise((resolve, reject) => { /* empty handler */ });
    const tid = setTimeout(() => {
      promise.reject('connect timeout');
    }, 6000);
    if (typeof MozWebSocket !== 'undefined') {
      this._socket = new MozWebSocket(url, this._webSocketProtocol);
    } else {
      this._socket = new WebSocket(url, this._webSocketProtocol);
    }
    this._socket.onmessage = this._onSocketMessage.bind(this);
    this._socket.onclose = () => {
      if (this._secondary === false) {
        if (this._silentDisconnect !== true) {
          this.dispatchEvent(new CustomEvent('casper-disconnected', { bubbles: true, composed: true, detail: { message: '', icon: 'sleep' } }));
        } else {
          this.dispatchEvent(new CustomEvent('casper-disconnected', { bubbles: true, composed: true, detail: { silent: true } }));
        }
      }
      this._silentDisconnect = false;
      this._socket = undefined;
    };
    this._socket.onopen = () => {
      clearTimeout(tid);
      promise.resolve(true);
    };
    return promise;
  }

  /**
   * Terminate connection to the casper server
   */
  disconnect () {
    this._clearData();
    clearTimeout(this._idleTimerId);
    this._idleTimerId = undefined;
    if (this._socket) {
      this._socket.close();
      this._socket = undefined;
    }
  }

  isOpen () {
    if (this._socket === undefined) {
      return false;
    } else {
      return this._socket.readyState === 1;
    }
  }

  async submitJob (job, handler, options) {
    let timeout;

    // .. set all keys that will be automatically replaced with session values
    job['user_id'] = null;
    job['entity_id'] = null;
    job['entity_schema'] = null;
    job['sharded_schema'] = null;
    job['subentity_id'] = null;
    job['subentity_schema'] = null;
    job['subentity_prefix'] = null;
    job['user_email'] = null;
    job['role_mask'] = null;
    job['module_mask'] = null;
    if (options != undefined && options.ttr) {
      job['ttr'] = options.ttr;
    }

    if (this._extraOptions !== undefined) {
      this._extraOptions.forEach((elem) => {
        job[elem.key] = elem.value;
      });
    }

    let target = { target: 'job-queue', tube: job.tube };
    if (options) {
      if (options.ttr !== undefined) {
        target.ttr = options.ttr;
      }
      if (options.validity) {
        target.validity = options.validity;
      }
      timeout = options.timeout;
      if (options.overlay) {
        this._showOverlay(options.overlay);
      }
    }
    timeout = timeout || this._defaultTimeout;
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), timeout * 1000);
    let request = { job: job, callback: this._submitJobResponse.bind(this), options: options, handler: handler, invokeId: ivk, timer: tid };
    if (this._socket === undefined) {
      await this._setSessionAsync(this.sessionCookie);
    }
    this._socket.send(ivk + ':PUT:' + JSON.stringify(target) + ':' + JSON.stringify(job));
    this._activeRequests.set(ivk, request);
  }

  _submitJobResponse (response, request, subscribe) {
    if (response.success === true && response.channel) {
      request.channel = response.channel;
      if (subscribe) {
        this._subscriptions.set(response.channel, { handler: request.handler, timer: request.timer, invokeId: request.invokeId, confirmed: true, job: true });
      }
      if (request.handler !== undefined) {
        if ((response.status_code !== undefined && response.status !== undefined) || (request.options && request.options.handleWithoutStatus)) {
          request.handler(response);
        }
      }
    } else {
      request.handler({
        message: ['O servidor recusou o pedido, p.f. tente mais tarde'],
        status: 'error',
        status_code: 500
      });
    }
  }

  async subscribeJob (jobId, handler, timeout) {
    let p = jobId.split(':');
    timeout = timeout || this._defaultTimeout;
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), timeout * 1000);
    let request = { tube: p[0], id: p[1], callback: this._subscribeJobResponse.bind(this), handler: handler, invokeId: ivk, timer: tid };
    if (this._socket === undefined) {
      await this._setSessionAsync(this.sessionCookie);
    }
    this._socket.send(ivk + ':SUBSCRIBE:' + JSON.stringify({ target: 'job', tube: request.tube, id: request.id }));
    this._activeRequests.set(ivk, request);
  }

  _subscribeJobResponse (response, request, subscribe) {
    if (response.success === true && response.channel) {
      request.channel = response.channel;
      if (request.handler !== undefined && response.status !== undefined) { // Note persistent jobs don't send status_code, don't test it
        request.handler(response);
      }
      if (subscribe) {
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

  async cancelJob (jobChannel, callback) {
    let subscription = this._subscriptions.get(jobChannel);
    if (subscription) {
      clearTimeout(subscription.timer);
      this._subscriptions.delete(jobChannel);
    }
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), this._defaultTimeout * 1000);
    let p = jobChannel.split(':');
    let request = { tube: p[0], id: p[1], callback: callback, timer: tid, invokeId: ivk };
    if (this._socket === undefined) {
      await this._setSessionAsync(this.sessionCookie);
    }
    this._socket.send(ivk + ':CANCEL:' + JSON.stringify({ target: 'job-queue', tube: request.tube, id: parseInt(request.id), status: 'cancelled' }));
    this._activeRequests.set(ivk, request);
  }

  /**
   * Async version of cancel job
   *
   * @param {String} jobChannel Id of the job channel in format tube:id
   * @param {Number} timeout in seconds
   */
  cancelJobAsync (jobChannel, timeout) {
    const p = jobChannel.split(':');
    return this._sendAsync(false, 'CANCEL', { target: 'job-queue', tube: p[0], id: parseInt(p[1]), status: 'cancelled' }, {}, timeout);
  }

  //***************************************************************************************//
  //                                                                                       //
  //                            ~~~ Login and Logout ~~~                                   //
  //                                                                                       //
  //***************************************************************************************//

  async _disconnectAsync () {
    const promise = new CasperSocketPromise((resolve, reject) => { /* empty handler */ });
    const tid = setTimeout(() => {
      promise.reject('disconnect timeout');
    }, 3000);
    this._socket.onclose = () => {
      promise.resolve(true);
      clearTimeout(tid);
      this._socket = undefined;
    };
    this._socket.close();
    return promise;
  }

  async _setSessionAsync (accessToken) {
    if (this._socket === undefined) {
      await this._connectAsync(this._url + ((this._port != undefined && this._port !== '') ? ':' + this._port : '') + '/' + this._path);
    }
    return this._sendAsync(false, 'SET', { target: 'session' }, { access_token: accessToken });
  }

  async _extendSessionAsync (timeout) {
    return this._sendAsync(false, 'EXTEND', { target: 'session' }, {}, timeout);
  }

  /**
   * Validate the current access token, retrieve access token (session) from cookie and set on websocket
   */
  async validateSession () {
    const accessToken = this.sessionCookie;

    if (accessToken) {
      try {
        this._showOverlay({ message: 'Validação de sessão em curso', icon: 'connecting', spinner: true, loading_icon: 'loading-icon-03', noCancelOnOutsideClick: true });
        const response = await this._setSessionAsync(accessToken);

        if (response.success === false) {
          this._accessToken = undefined;
          this.deleteSessionCookie();
          this.dispatchEvent(new CustomEvent('casper-signed-out', { bubbles: true, composed: true }));
        } else {
          this._accessToken = accessToken;
          if (response.entity_id) {
            window.localStorage.setItem('casper-last-entity-id', response.entity_id);

            // add internal subscription
            this.subscribeNotifications('entity-push-events', response.entity_id, (notification) => {
              this.dispatchEvent(new CustomEvent(notification.event, {
                detail: notification.detail,
                bubbles: true,
                composed: true
              }))
            });

            this._reSubscribeNotifications(response.entity_id);
          }
          if (response.user_email) {
            this.savedEmail = response.user_email;
          }
          this._accessValidity = this.sessionValidity; // read back from cookie

          this._startIdleTimer();
          this.dispatchEvent(new CustomEvent('casper-signed-in', { bubbles: true, composed: true, detail: response }));
        }

      } catch (exception) {
        console.log(exception);
      }
      return;
    }
    this.deleteSessionCookie();
    this.dispatchEvent(new CustomEvent('casper-signed-out', { bubbles: true, composed: true }));
  }

  _reSubscribeNotifications (entity_id) {
    if (this._subscriptions) {
      this._subscriptions.forEach(function (subscription, key, map) {
        if (subscription.notification && subscription.confirmed) {
          let a = key.split(':');

          if (a[0] === 'company') {
            if (a[1] == entity_id && subscription.handler) {
              this._subscribeNotifications(a[0], a[1], subscription.handler);
            } else {
              this._unsubscribeNotifications(a[0], a[1]);
            }
          } else {
            this._subscribeNotifications(a[0], a[1], subscription.handler);
          }
        }
      }.bind(this));
    }
  }

  //***************************************************************************************//
  //                                                                                       //
  //                              ~~~ Entity Logout ~~~                                 //
  //                                                                                       //
  //***************************************************************************************//

  async signOutViaApi () {
    try {
      if (this.sessionCookie) {
        const request = await fetch('/login/sign-out', {
          headers: {
            'x-casper-access-token': this.sessionCookie,
            'Content-Type': 'application/json'
          }
        });
      }
    } catch (exception) {
      // ... ignore and proceed with the the logout
    } finally {
      this.disconnect();
      this.wipeCredentials();
      window.location = '/login';
    }
  }

  disconnectAndWipeCredentials () {
    this._socket.onclose = undefined;
    this.wipeCredentials();
    this.disconnect();
  }

  //***************************************************************************************//
  //                                                                                       //
  //                              ~~~ Entity switching ~~~                                 //
  //                                                                                       //
  //***************************************************************************************//

  async connectAndSetSession (url, accessToken) {
    this._initData();
    await this._connectAsync(url);
    return await this._setSessionAsync(accessToken);
  }

  /**
   * Switch the current entity or sub-entity using the HTTP bridge to access an interal microservice
   *
   * @param {Object} body the payload to send on the put request, must have a known 'action'
   */
  async switchViaBridge (body) {
    try {
      let response;

      // ... block the user interface while the request is in flight ...
      this._showOverlay({ message: 'Por favor aguarde', icon: 'switch', spinner: true, noCancelOnOutsideClick: true });

      // ... make the request and handle the response ...
      switch (body.action) {
        case 'impersonate':
        case 'stop-impersonation':

          // ... when impersonating or exiting impersonation it's assumed the caller app will always reload the page
          response = await this.hput(this.app.cdbUrl + '/entity/impersonate', body);
          this.saveSessionCookie(response.access_token, response.access_ttl, response.issuer_url);
          return response;

        case 'switch':

          // ... when switching entities it's assumed the caller app will always reload the page
          response = await this.hput(this.app.cdbUrl + '/entity/switch', body);
          this.saveSessionCookie(response.access_token, response.access_ttl, response.issuer_url);
          return response;

        case 'sub-switch':

          // ... sub-entity switches are soft, they do not reload the page
          response = await this.hput(this.app.cdbUrl + '/entity/sub-switch', body);

          // ... save the token, if we reload now it will be validaded by page load sequence ...
          this.saveSessionCookie(response.access_token, response.access_ttl, response.issuer_url);

          // ... here we assume the caller will not reload the page, so the session must be updated ...
          const sessionResponse = await this._setSessionAsync(response.access_token);

          // ... now that the session is validated save on local var to avoid a spurious kicking ...
          this._accessToken = response.access_token;
          sessionResponse.url = response.url;
          this._dismissOverlay();

          // ... notify the application
          this.dispatchEvent(new CustomEvent('casper-signed-in', {
            bubbles: true,
            composed: true,
            detail: sessionResponse
          }));
          return sessionResponse;
      }
    } catch (e) {
      if (e.status_code === 504) {
        this._showOverlay({ message: 'Tempo de espera ultrapassado', icon: 'timeout' });
      } else {
        this._showOverlay({ message: `Erro ${e.error} (${e.status_code})`, icon: 'error' });
      }
    }
  }

  //***************************************************************************************//
  //                                                                                       //
  //                               ~~~ EPaper Documents ~~~                                //
  //                                                                                       //
  //***************************************************************************************//

  registerDocumentHandler (docmentId, documentHandler) {
    this._documents.set(docmentId, documentHandler);
  }

  /**
   * Open document template
   */
  openDocument (chapterModel) {
    // TODO REMOVE FROM HERE WHEN PAPER IS UNIFIED
    if (app.session_data.app.certified_software_notice !== undefined) {
      chapterModel.overridable_system_variables = {
        CERTIFIED_SOFTWARE_NOTICE: app.session_data.app.certified_software_notice
      };
    }
    return this._sendAsync(true, 'OPEN', { target: 'document' }, chapterModel);
  }

  loadDocument (chapterModel) {
    return this._sendAsync(true, 'LOAD', { target: 'document', id: chapterModel.id }, chapterModel);
  }

  reloadDocument (id) {
    return this._sendAsync(true, 'RELOAD', { target: 'document', id: id });
  }

  closeDocument (id, reload) {
    let options;
    if (undefined != id) {
      options = { target: 'document', id: id }
    } else {
      options = { target: 'document' }
    }
    if (reload !== undefined && reload === false) {
      options.reload = false;
    }
    return this._sendAsync(true, 'CLOSE', options);
  }

  sendKey (id, key, modifier) {
    const params = { input: { key: key } };
    if (modifier) {
      params.input.modifier = modifier;
    }
    return this._sendAsync(true, 'SET', { target: 'document', id: id }, params);
  }

  moveCursor (id, motion) {
    return this._sendAsync(true, 'SET', { target: 'document', id: id }, { input: { motion: motion } });
  }

  setText (id, value, motion) {
    const params = { input: { text: value } };
    if (motion) {
      params.input.motion = motion;
    }
    return this._sendAsync(true, 'SET', { target: 'document', id: id }, params);
  }

  setTextT (id, value, motion, final) {
    const params = { input: { text: value, final_update: final } };
    if (motion) {
      params.input.motion = motion;
    }
    return this._sendAsync(true, 'SET', { target: 'document', id: id }, params, -1);
  }

  sendClick (id, x, y) {
    return this._sendAsync(true, 'SET', { target: 'document', id: id }, { input: { click: { x: x, y: y } } });
  }

  gotoPage (id, pageNumber) {
    return this._sendAsync(true, 'SET', { target: 'document', id: id }, { properties: { page: pageNumber } });
  }

  setScale (id, scale) {
    return this._sendAsync(true, 'SET', { target: 'document', id: id }, { properties: { scale: scale } });
  }

  setEditable (id, editable) {
    return this._sendAsync(true, 'SET', { target: 'document', id: id }, { properties: { editable: editable } });
  }

  /**
   * Requests the server side hint for the current hovering point
   *
   * @param {number} id document identifier
   * @param {number} x coordinate where the mouse is overing
   * @param {number} y coordinate where the mouse is overing
   */
  getHint (id, x, y) {
    return this._sendAsync(false /* TODO CHECK*/, 'GET', { target: 'document', id: id }, { hint: { x: 1.0 * x.toFixed(2), y: 1.0 * y.toFixed(2) } });
  }

  getBandDri (id, bandType, bandIdx) {
    return this._sendAsync(false, 'GET', { target: 'document', id: id }, { band: { type: bandType, id: bandIdx } });
  }

  addBand (id, type, bandId) {
    return this._sendAsync(true, 'ADD', { target: 'document', id: id }, { band: { type: type, id: bandId } });
  }

  deleteBand (id, type, bandId) {
    return this._sendAsync(true, 'REMOVE', { target: 'document', id: id }, { band: { type: type, id: bandId } });
  }

  async setListValue (id, value, callback) {
    const ivk = this._selectInvokeId();
    const tid = setTimeout(() => this._timeoutHandler(ivk), this._defaultTimeout * 1000);
    const options = { target: "document", id: id };
    const command = { input: { text: value, key: 'save' } };
    const request = { callback: callback, timer: tid, invokeId: ivk };
    if (this._socket === undefined) {
      await this._setSessionAsync(this.sessionCookie);
    }
    this._socket.send(ivk + ':SET:' + JSON.stringify(options) + ':' + JSON.stringify(command));
    this._activeRequests.set(ivk, request);
    this.userActivity();
  }

  /*** NOTFICATION STUFF **/

  async getNotifications (channel, callback) {
    const ivk = this._selectInvokeId();
    const tid = setTimeout(() => this._timeoutHandler(ivk), this._defaultTimeout * 1000);
    const request = {
      invokeId: ivk, timer: tid, callback: function (response) {
        try {
          const notifications = [];
          for (var m of response.members) {
            notifications.push(JSON.parse(m));
          }
          callback(notifications);
        } catch (e) {
          callback([]);
        }
      }.bind(this)
    };
    const options = { target: 'notifications', channel: channel };
    if (this._socket === undefined) {
      await this._setSessionAsync(this.sessionCookie);
    }
    this._socket.send(ivk + ':GET:' + JSON.stringify(options));
    this._activeRequests.set(ivk, request);
  }

  /**
   * Subscribe to server side notifications, public method
   *
   * @param {String} channel notification channel name
   * @param {String} id      optional entity identifier
   * @param {Object} handler functions that is called when the server pushes a notification
   */
  subscribeNotifications (channel, id, handler) {
    const subscription = this._subscriptions.get(channel + ':' + id);
    if (subscription) {
      subscription.handler = handler; // The subscription already exists just update the handler
    } else {
      this._subscribeNotifications(channel, id, handler); // not yet, need to subscribe on server
    }
  }

  /**
   * Inner method to subscribe to webserver notifications
   *
   * @param {String} channel notification channel name
   * @param {String} id      optional entity identifier
   * @param {Object} handler functions that is called when the server pushes a notification
   */
  async _subscribeNotifications (channel, id, handler) {
    const ivk = this._selectInvokeId();
    const chn = channel + ':' + id;
    const tid = setTimeout(() => this._timeoutHandler(ivk), this._defaultTimeout * 1000);
    const request = { callback: this._subscribeNotificationsResponse.bind(this), channel: chn, handler: handler, timer: tid, invokeId: ivk };
    if (this._socket === undefined) {
      await this._setSessionAsync(this.sessionCookie);
    }
    this._socket.send(ivk + ':SUBSCRIBE:' + JSON.stringify({ target: 'notifications', channel: channel, id: id }));
    this._activeRequests.set(ivk, request);
    this._subscriptions.set(chn, { handler: handler, timer: tid, invokeId: ivk, confirmed: false, notification: true });
  }

  _subscribeNotificationsResponse (response, request) {
    let subscription = undefined;

    if (request.channel) {
      subscription = this._subscriptions.get(request.channel);
      if (subscription) {
        if (response.success === true) {
          subscription.timer = undefined;
          subscription.invokeId = undefined;
          subscription.confirmed = true;
          return;
        }
      }
    }
    // cleanup
    if (subscription) {
      if (subscription.handler) {
        subscription.handler("failed"); // TODO normalize response
      }
      this._subscriptions.delete(request.channel);
    }
  }

  _unsubscribeNotifications (channel, id) {
    return this._sendAsync(false, 'UNSUBSCRIBE', { target: 'notifications', channel: channel, id: id });
  }

  async getData (urn, timeout, callback) {
    let ivk = this._selectInvokeId();
    let tid = setTimeout(() => this._timeoutHandler(ivk), (timeout || this._defaultTimeout) * 1000);
    let options = { target: "jsonapi", urn: urn };
    let request = { callback: callback, timer: tid, invokeId: ivk };
    if (this._socket === undefined) {
      await this._setSessionAsync(this.sessionCookie);
    }
    this._socket.send(ivk + ':GET:' + JSON.stringify(options));
    this._activeRequests.set(ivk, request);
    return ivk;
  }

  //***************************************************************************************//
  //                                                                                       //
  //                               ~~~ Internal methods ~~~                                //
  //                                                                                       //
  //***************************************************************************************//

  /**
   * Send command to the HTTP micro service brige with a promise for async / await use
   *
   * @param {String} verb the HTTP verb to use (GET, PUT, POST, PATCH, DELETE)
   * @param {String} url the target URL
   * @param {Object} body optional body object
   * @param {Number} timeout in seconds
   */
  _http_upstream (verb, url, body, timeout) {
    return this._sendAsync(this._secondary, verb, { target: 'http', url: url, headers: { 'content-type': 'application/json', 'accept': 'application/json' } }, body, timeout);
  }

  /**
   * Send command to the server with a promise for aysnc / await use
   *
   * @param {Boolean} isUserActivity true to trigger user activity
   * @param {String} verb the command verb to use
   * @param {Object} options the command options
   * @param {Object} params the command parameters
   * @param {Number} timeout in seconds (use -1 to disable)
   */
  async _sendAsync (isUserActivity, verb, options, params, timeout) {
    const ivk = this._selectInvokeId();
    const tid = timeout == -1 ? undefined : (setTimeout(() => this._timeoutHandler(ivk), (timeout || this._defaultTimeout) * 1000));
    const promise = new CasperSocketPromise((resolve, reject) => { /* empty handler */ });
    this._activeRequests.set(ivk, { promise: promise, timer: tid, invokeId: ivk, jsonapi: options.jsonapi });
    if (isUserActivity) {
      this.userActivity();
    }
    if (this._socket === undefined) {
      await this._setSessionAsync(this.sessionCookie);
    }
    if (params !== undefined) {
      this._socket.send(`${ivk}:${verb}:${JSON.stringify(options)}:${JSON.stringify(params)}`);
    } else {
      this._socket.send(`${ivk}:${verb}:${JSON.stringify(options)}`);
    }
    return promise;
  }

  /**
   * Assigns the next invoke id for communication with the server
   */
  _selectInvokeId () {
    if (!this._freedInvokes || this._freedInvokes.length === 0) {
      return this._nextInvokeId++;
    } else {
      return this._freedInvokes.shift();
    }
  }

  _freeInvokeId (invoke) {
    if (!isNaN(invoke)) {
      this._freedInvokes.push(invoke);
    } else {
      console.error('invalid invoke id');
    }
  }

  /**
   * Message decoder and handler, decodes the JSON payloads and delivers the message to the clients
   *
   * @param {Object} message the web socket message
   */
  _onSocketMessage (message) {
    try {
      let request, payload, invokeId, timerId, releaseInvoke = true;

      let data = message.data;
      const start = data.indexOf('0:N:{');
      if (start === 0) {
        const end = data.indexOf('"}:{"');
        if (-1 !== end) {
          const channel = data.substring(16, end);
          const notification = JSON.parse(data.substring(end + 3));
          const subscription = this._subscriptions.get(channel);

          if (subscription) {
            timerId = subscription.timer;
            if (timerId) {
              if ( !['in-progress', 'reset'].includes(notification.status) ) {

                let request = this._activeRequests.get(subscription.invokeId);
                if (request) {
                  if (request.options && request.options.overlay) {
                    if (notification.status === 'error') {
                      this._showOverlay({ message: notification.message[0], icon: 'error' });
                    } else if (notification.status === 'completed') {
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
              if (subscription.confirmed && subscription.notification && subscription.handler) {
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
      if (!isNaN(invokeId)) {
        const offset = invokeId.toString().length;
        if (data.substring(offset, offset + 3) === ':D:' || data.substring(offset, offset + 3) === ':n:') {
          const documentHandler = this._documents.get(invokeId);
          if (documentHandler) {
            documentHandler(data.substring(offset + 1));
          }
        } else {
          request = this._activeRequests.get(invokeId);
          if (request !== undefined) {
            let payload_start, subscribe;

            timerId = request.timer;
            if ((payload_start = data.indexOf(':R:{')) === offset
              || (payload_start = data.indexOf(':S:{')) === offset) {
              payload = JSON.parse(data.substring(payload_start + 3));
              if (request.jsonapi === true) {
                if (payload.errors === undefined) {
                  if (payload.data instanceof Array) {
                    payload.data.forEach((element, index, array) => {
                      element.attributes.id = element.id;
                      if (element.relationships) {
                        element.attributes.relationships = element.relationships;
                      }
                      array[index] = element.attributes;
                    });
                  } else {
                    payload.data.attributes.id = payload.data.id;
                    if (payload.data.relationships) {
                      payload.data.attributes.relationships = payload.data.relationships;
                    }
                    payload.data = payload.data.attributes;
                  }
                } else {
                  request.promise.reject(payload.errors);
                }
              }
              if (request.promise) {
                clearTimeout(timerId);
                this._activeRequests.delete(invokeId);
                this._freeInvokeId(invokeId);
                if (request.jsonapi === true && payload.errors !== undefined) {
                  request.promise.reject(payload.errors);
                } else {
                  request.promise.resolve(payload);
                }
                return;
              }
            } else if ((payload_start = data.indexOf(':E:{')) === offset) {
              payload = JSON.parse(data.substring(payload_start + 3));
              if (request.promise !== undefined) {
                request.promise.reject({ error: "Unknown error", status_code: 500, payload_errors: payload.errors });
                clearTimeout(timerId);
                this._activeRequests.delete(invokeId);
                this._freeInvokeId(invokeId);
                return;
              }
            } else if ((payload_start = data.indexOf(':H:')) === offset) {
              let response = data.substring(payload_start + 3);
              let status_code = parseInt(response);
              response = response.substring(response.indexOf(':') + 1);
              if (response.length) {
                try {
                  payload = JSON.parse(response);
                } catch (exception) {
                  status_code = 500;
                  payload = { error: 'Invalid JSON data from server' };
                }
              }
              if (status_code >= 100 && status_code < 299) {
                request.promise.resolve(payload);
              } else {
                request.promise.reject({ error: (payload !== undefined ? payload.error : 'Bridge error'), status_code: status_code });
              }
              clearTimeout(timerId);
              this._activeRequests.delete(invokeId);
              this._freeInvokeId(invokeId);
              return;
            } else {
              // Unknown message ignore
              console.error('casper protocol decoding error!!!');
            }
            if (!(payload.channel && timerId && (!payload.status || ['in-progress', 'queued'].includes(payload.status.status)))) {
              // ... release the invoke ...
              if (timerId) {
                clearTimeout(timerId);
              }
              this._activeRequests.delete(invokeId);
              this._freeInvokeId(invokeId);
              subscribe = false;
            } else {
              if (false) {
                console.log(`keeping invoke ${invokeId} alive for channel ${payload.channel}`);
              }
              subscribe = true;
            }

            if (payload && request.callback !== undefined) {
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
    if (request !== undefined) {
      if (request.channel) {
        let subscription = this._subscriptions.get(request.channel);
        if (subscription && subscription.job === true && subscription.confirmed === true) {
          if (window.app && window.app.wizard && window.app.wizard.channel === request.channel) {
            handled = true;
            this._startIdleTimer();
          }
        }
        this._subscriptions.delete(request.channel);
      }
      if (request.handler !== undefined) {
        request.handler({
          message: ['Tempo de espera ultrapassado'],
          status: 'error',
          status_code: 504
        });
      }
      if (request.promise !== undefined) {
        request.promise.reject({ error: 'HTTP bridge Timeout', status_code: 504 });
      }
      this._activeRequests.delete(invokeId);
      if (false) {
        this._freeInvokeId(invokeId); // do not recycle this ID it's lost for the duration of the socket life
      }
      if (request.hideTimeout === true) {
        handled = true;
      }
    }
    if (!handled) {
      this._showOverlay({ message: 'Tempo de espera ultrapassado', icon: 'timeout' });
    }
  }

  /**
   * Clears timers and internal data
   */
  _clearData () {
    if (this._activeRequests) {
      for (let request of this._activeRequests.values()) {
        if (request.timer) {
          clearTimeout(request.timer);
        }
      }
      this._activeRequests.clear();
    }
    if (this._documents) {
      this._documents.clear();
    }
    if (this._subscriptions) {
      this._subscriptions.forEach(function (subscription, channel, subs) {
        if (!(subscription.notification && subscription.confirmed)) {
          subs.delete(channel);
        }
      });
    }
    this._initData(false);
  }

  /**
   * Initializes internal data structures
   */
  _initData (clearSubs) {
    this._savedEmail = undefined;       // The email used to sign-in
    this._accessToken = undefined;      // The current access token in use
    this._accessValidity = undefined;   // Last second of session validity in EPOCH (approximation)
    this._freedInvokes = [];            // keeps the invokes that were returned by the server
    this._activeRequests = new Map();   // hash, key is the Invoke value the request in flight
    this._documents = new Map();
    this._nextInvokeId = 1;             // The next fresh invoke ID
    if (this._subscriptions === undefined || clearSubs === true) {
      this._subscriptions = new Map();  // Registry of server subscriptions, key is channel
    }
    this._applicationInactive = false;
  }

  /**
   * Helper to bring the overlay that blocks the user interface
   *
   * @param {Object} detail
   */
  _showOverlay (detail) {
    if (this._secondary === false) {
      this.dispatchEvent(new CustomEvent('casper-show-overlay', {
        bubbles: true,
        composed: true,
        detail: detail
      })
      );
    }
  }

  /**
   * Helper to dismiss the overlay that blocks the user interface
   */
  _dismissOverlay () {
    if (this._secondary === false) {
      this.dispatchEvent(new CustomEvent('casper-dismiss-overlay', {
        bubbles: true,
        composed: true
      }));
    }
  }

  /**
   * This method should be called whenever the user does a click or presses a key.
   *
   * @param {Object} The event created by user activity (ignored)
   */
  async userActivity (event) {
    if (this._applicationInactive === true) {
      this._applicationInactive = false;
      this.checkIfSessionChanged();
    }
    this._startIdleTimer();
    if (this._accessValidity !== undefined && this._secondary === false) {
      const now = new Date().valueOf() / 1000;
      if (true) {
        console.log('TTL is ~', this._accessValidity - now);
      }
      if (this._accessToken && (this._accessValidity - now < this._sessionRenewTolerance)) {
        try {
          const response = await this._extendSessionAsync(3000);
          if (response.success === true) {
            this.saveSessionCookie(this._accessToken, response.ttl - 30, this.issuerUrl);
            this._accessValidity = this.sessionValidity; // read back from cookie
          }
        } catch (e) {
          console.log(e);
        }
        if (true) {
          console.log('NEW TTL is ~', this._accessValidity - now);
        }
      }
    }
  }

  /**
   * Sends a session extend command just to prevent the server from closing the socket due to inactivity
   *
   * @note we don't touch the cookie
   */
  async keepAlive () {
    const response = await this._extendSessionAsync(3000);
    if (response.success === true) {
      this._startIdleTimer();
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
    this._idleTimerId = setTimeout(e => this._userIdleTimeoutHandler(e), this._userIdleTimeout * 1000);
  }

  /**
   * Handler for user inactivity timeout
   *
   * @note Suspension is prevented when a wizard is opened or generally speaking a server job is pending
   */
  async _userIdleTimeoutHandler (event) {
    if (this._secondary === false) {
      for (let subscription of this._subscriptions.values()) {
        if (subscription.confirmed === true && subscription.job === true) {
          console.warn('refusing to go idle because at least one job subscription is active');
          return;
        }
      }
      try {
        if (this._accessToken) {
          const response = await this._extendSessionAsync(3000);
          if (response.success === true) {
            this.saveSessionCookie(this._accessToken, response.ttl - 30, this.issuerUrl);
          }
        }
      } catch (e) {
        console.log(e);
      } finally {
        this._applicationInactive = true;
        this._showOverlay({ message: 'Sessão suspensa por inatividade', icon: 'cloud', opacity: 0.15 });
        this._silentDisconnect = true;
        this.disconnect();
      }
    } else {
      this._applicationInactive = true;
      this._silentDisconnect = true;
      this.disconnect();
    }
  }

  /**
   * If the session in memory is not same we have saved in the cookie it means another browser window/tab changed it
   *
   * @note This could mean the user changed the login account or selected another entity,
   *       so the only safe action is to reload the page and start fresh with new session
   */
  checkIfSessionChanged () {
    if (this._secondary === false) {
      if (this._accessToken !== undefined && this._accessToken !== this.sessionCookie) {
        window.location.reload();
      } else {
        this._startIdleTimer();
      }
    }
  }

  //***************************************************************************************//
  //                                                                                       //
  //                      ~~~ Cookie and local storage handling ~~~                        //
  //                                                                                       //
  //***************************************************************************************//

  /**
   * Save the cookie
   *
   * @param {String} name   cookie name
   * @param {String} value  value of the cookie
   * @param {Number} ttl    time to live in seconds
   */
  saveCookie (name, value, ttl) {
    if ( CasperSocket.useLocalStorage ) {
      window.localStorage.setItem(name, value);
    } else {
      let cookie = `${name}=${value};path=/`;

      if (window.location.protocol === 'https:') {
        cookie += ';secure=true';
      }
      if (this._cookieDomain) {
        cookie += `;domain=${this._cookieDomain}`;
      }
      if (ttl) {
        let now = new Date();
        now.setSeconds(now.getSeconds() + ttl);
        cookie += `;expires=${now.toUTCString()}`
      }
      cookie += ';';
      document.cookie = cookie;
    }
  }

  /**
   * Clears the cookie
   *
   * @param {String} name   cookie name
   */
  deleteCookie (name) {
    if ( CasperSocket.useLocalStorage ) {
      window.localStorage.removeItem(name);
    } else {
      let cookie = `${name}=`;
      if (this._cookieDomain) {
        cookie += `;domain=${this._cookieDomain}`;
      }
      cookie += ';path=/;expires=Thu, 01 Jan 2018 00:00:01 GMT;'
      document.cookie = cookie;
    }
  }

  /**
   * Save session cookie with the current access token
   *
   * @param {String} accessToken the access token generated by the server
   * @param {Number} ttl Time to live how long the token should live in seconds
   * @param {String} issuer_url the URL of the server that issued the access token
   */
  saveSessionCookie (accessToken, ttl, issuer_url) {
    this.saveCookie('casper_session', accessToken, ttl);
    if (issuer_url) {
      this.saveCookie('casper_issuer', issuer_url, ttl);
    }
    if (ttl) {
      this.saveCookie('casper_validity', (new Date().valueOf()) / 1000 + ttl, ttl);
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
   * @param {String} cookie name of the key
   * @param {Number} minLength minimum length of the cookie
   * @return cookie value or undefined if the cookie does not exist or it's too short
   */
  static readCookie (cookie, minLength) {
    if ( CasperSocket.useLocalStorage ) {
      return window.localStorage.getItem(cookie);
    } else {
      let value;
      let jar = document.cookie;
      let start = jar.indexOf(cookie + '=');

      if (start === -1) {
        return undefined;
      } else {
        start += cookie.length + 1;
      }
      let end = jar.indexOf(';', start);
      if (end === -1) {
        value = jar.substring(start, jar.length);
      } else {
        value = jar.substring(start, end);
      }
      if (minLength === undefined) {
        return value;
      } else {
        return value.length >= minLength ? value : undefined;
      }
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
    if (this._savedEmail !== email) {
      window.localStorage.setItem('casper-user-email', email);
      this._savedEmail = email;
    }
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

  jget (urn, timeout) {
    return this._sendAsync(this._secondary, 'GET', { target: 'jsonapi', urn: urn, jsonapi: true }, undefined, timeout);
  }

  jpost (urn, body, timeout) {
    return this._sendAsync(this._secondary, 'POST', { target: 'jsonapi', urn: urn, jsonapi: true }, body, timeout);
  }

  jpatch (urn, body, timeout) {
    return this._sendAsync(this._secondary, 'PATCH', { target: 'jsonapi', urn: urn, jsonapi: true }, body, timeout);
  }

  jdelete (urn, timeout) {
    return this._sendAsync(this._secondary, 'DELETE', { target: 'jsonapi', urn: urn, jsonapi: true }, undefined, timeout);
  }

  subscribeTreeLazyload (urn, data, timeout) {
    const options = { target: 'lazyload',
                      urn: urn,
                      is_tree: true,
                      parent_column: data.parentColumn,
                      id_column: data.idColumn,
                      table_type: data.tableType,
                      table_name: data.tableName };
    return this._sendAsync(this._secondary, 'SUBSCRIBE', options, undefined, timeout);
  }

  subscribeLazyload (urn, parentColumn, timeout) {
    const options = { target: 'lazyload',
                      urn: urn,
                      parent_column: parentColumn };

    return this._sendAsync(this._secondary, 'SUBSCRIBE', options, undefined, timeout);
  }

  unsubscribeLazyload (urn, timeout) {
    return this._sendAsync(this._secondary, 'UNSUBSCRIBE', { target: 'lazyload', urn: urn }, undefined, timeout);
  }

  unsubscribeAllLazyload (timeout) {
    console.log('Clearing all the socket lazyload subscriptions');
    return this._sendAsync(this._secondary, 'UNSUBSCRIBE', { target: 'lazyload' }, undefined, timeout);
  }

  expandLazyload (urn, parentId, timeout) {
    return this._sendAsync(this._secondary, 'GET', { target: 'lazyload', urn: urn, active_id: parentId, action: 'expand' }, undefined, timeout);
  }

  collapseLazyload (urn, parentId, timeout) {
    return this._sendAsync(this._secondary, 'GET', { target: 'lazyload', urn: urn, active_id: parentId, action: 'collapse' }, undefined, timeout);
  }

  getLazyload (urn, data, timeout,) {
    const options = { target: 'lazyload',
                      urn: urn,
                      id_column: data.idColumn,
                      active_id: data.activeId,
                      direction: data.direction,
                      action: 'fetch',
                      nr_of_items: data.nrOfItems,
                      active_index: data.activeIndex,
                      jsonapi: true };

    return this._sendAsync(this._secondary, 'GET', options, undefined, timeout);
  }
}

window.customElements.define('casper-socket', CasperSocket);
