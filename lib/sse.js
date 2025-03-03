/**
 * Copyright (C) 2016-2023 Maxime Petazzoni <maxime.petazzoni@bulix.org>.
 * All rights reserved.
 */


/**
 * @type SSE
 * @param {string} url
 * @param {SSEOptions} options
 * @return {SSE}
 */
var SSE = function (url, options) {
  if (!(this instanceof SSE)) {
    return new SSE(url, options);
  }

  /** @type {number} */
  this.INITIALIZING = -1;
  /** @type {number} */
  this.CONNECTING = 0;
  /** @type {number} */
  this.OPEN = 1;
  /** @type {number} */
  this.CLOSED = 2;

  /** @type {string} */
  this.url = url;

  options = options || {};
  this.headers = options.headers || {};
  this.payload = options.payload !== undefined ? options.payload : '';
  this.method = options.method || (this.payload && 'POST' || 'GET');
  this.withCredentials = !!options.withCredentials;
  this.debug = !!options.debug;

  /** @type {string} */
  this.FIELD_SEPARATOR = ':';

  /** @type { {[key: string]: EventListener} } */
  this.listeners = {};

  /** @type {XMLHttpRequest} */
  this.xhr = null;
  /** @type {number} */
  this.readyState = this.INITIALIZING;
  /** @type {number} */
  this.progress = 0;
  /** @type {string} */
  this.chunk = '';

  /**
   * @type AddEventListener
   */
  this.addEventListener = function(type, listener) {
    if (this.listeners[type] === undefined) {
      this.listeners[type] = [];
    }

    if (this.listeners[type].indexOf(listener) === -1) {
      this.listeners[type].push(listener);
    }
  };

  /**
   * @type RemoveEventListener
   */
  this.removeEventListener = function(type, listener) {
    if (this.listeners[type] === undefined) {
      return;
    }

    var filtered = [];
    this.listeners[type].forEach(function(element) {
      if (element !== listener) {
        filtered.push(element);
      }
    });
    if (filtered.length === 0) {
      delete this.listeners[type];
    } else {
      this.listeners[type] = filtered;
    }
  };

  /**
   * @type DispatchEvent
   */
  this.dispatchEvent = function(e) {
    if (!e) {
      return true;
    }

    if (this.debug) {
      console.debug(e);
    }

    e.source = this;

    var onHandler = 'on' + e.type;
    if (this.hasOwnProperty(onHandler)) {
      this[onHandler].call(this, e);
      if (e.defaultPrevented) {
        return false;
      }
    }

    if (this.listeners[e.type]) {
      return this.listeners[e.type].every(function(callback) {
        callback(e);
        return !e.defaultPrevented;
      });
    }

    return true;
  };

  this._setReadyState = function(state) {
    var event = new CustomEvent('readystatechange');
    event.readyState = state;
    this.readyState = state;
    this.dispatchEvent(event);
  };

  this._onStreamFailure = function(e) {
    var event = new CustomEvent('error');
    event.data = e.currentTarget.response;
    this.dispatchEvent(event);
    this.close();
  }

  this._onStreamAbort = function(e) {
    this.dispatchEvent(new CustomEvent('abort'));
    this.close();
  }

  this._onStreamProgress = function(e) {
    if (!this.xhr) {
      return;
    }

    if (this.xhr.status !== 200) {
      this._onStreamFailure(e);
      return;
    }

    if (this.readyState == this.CONNECTING) {
      this.dispatchEvent(new CustomEvent('open'));
      this._setReadyState(this.OPEN);
    }

    var data = this.xhr.responseText.substring(this.progress);

    this.progress += data.length;
    var parts = (this.chunk + data).split(/(\r\n|\r|\n){2}/g);

    // we assume that the last chunk can be incomplete because of buffering or other network effects
    // so we always save the last part to merge it with the next incoming packet
    var lastPart = parts.pop();
    parts.forEach(function(part) {
        if (part.trim().length > 0) {
            this.dispatchEvent(this._parseEventChunk(part));
        }
    }.bind(this));
    this.chunk = lastPart;
  };

  this._onStreamLoaded = function(e) {
    this._onStreamProgress(e);

    // Parse the last chunk.
    this.dispatchEvent(this._parseEventChunk(this.chunk));
    this.chunk = '';
  };

  /**
   * Parse a received SSE event chunk into a constructed event object.
   *
   * Reference: https://html.spec.whatwg.org/multipage/server-sent-events.html#dispatchMessage
   */
  this._parseEventChunk = function(chunk) {
    if (!chunk || chunk.length === 0) {
      return null;
    }

    if (this.debug) {
      console.debug(chunk);
    }

    var e = {'id': null, 'retry': null, 'data': null, 'event': 'message'};
    chunk.split(/\n|\r\n|\r/).forEach(function(line) {
      line = line.trimRight();
      var index = line.indexOf(this.FIELD_SEPARATOR);
      if (index <= 0) {
        // Line was either empty, or started with a separator and is a comment.
        // Either way, ignore.
        return;
      }

      var field = line.substring(0, index);
      if (!(field in e)) {
        return;
      }

      // only first whitespace should be trimmed
      var skip = (line[index+1] === ' ') ? 2 : 1;
      var value = line.substring(index + skip);

      // consecutive 'data' is concatenated with newlines
      if (field === 'data' && e[field] !== null) {
          e['data'] += "\n" + value;
      } else {
        e[field] = value;
      }
    }.bind(this));

    var event = new CustomEvent(e.event);
    event.data = e.data || '';
    event.id = e.id;
    return event;
  };

  this._checkStreamClosed = function() {
    if (!this.xhr) {
      return;
    }

    if (this.xhr.readyState === XMLHttpRequest.DONE) {
      this._setReadyState(this.CLOSED);
    }
  };

  /**
   * starts the streaming
   * @type Stream
   * @return {void}
   */
  this.stream = function() {
    if (this.xhr) {
      // Already connected.
      return;
    }

    this._setReadyState(this.CONNECTING);

    this.xhr = new XMLHttpRequest();
    this.xhr.addEventListener('progress', this._onStreamProgress.bind(this));
    this.xhr.addEventListener('load', this._onStreamLoaded.bind(this));
    this.xhr.addEventListener('readystatechange', this._checkStreamClosed.bind(this));
    this.xhr.addEventListener('error', this._onStreamFailure.bind(this));
    this.xhr.addEventListener('abort', this._onStreamAbort.bind(this));
    this.xhr.open(this.method, this.url);
    for (var header in this.headers) {
      this.xhr.setRequestHeader(header, this.headers[header]);
    }
    this.xhr.withCredentials = this.withCredentials;
    this.xhr.send(this.payload);
  };

  /**
   * closes the stream
   * @type Close
   * @return {void}
   */
  this.close = function() {
    if (this.readyState === this.CLOSED) {
      return;
    }

    this.xhr.abort();
    this.xhr = null;
    this._setReadyState(this.CLOSED);
  };

  if (options.start === undefined || options.start) {
    this.stream();
  }
};

// Export our SSE module for npm.js
if (typeof exports !== 'undefined') {
  exports.SSE = SSE;
}

// Export as an ECMAScript module
export { SSE };

/**
 * @typedef { {[key: string]: string} } SSEHeaders
 */
/**
 * @typedef {Object} SSEOptions
 * @property {SSEHeaders} [headers] - headers
 * @property {string} [payload] - payload as a string
 * @property {string} [method] - HTTP Method
 * @property {boolean} [withCredentials] - flag, if credentials needed
 * @property {boolean} [debug] - debugging flag
 */
/**
 * @typedef {Object} _SSEvent
 * @property {string} id
 * @property {string} data
 */
/**
 * @typedef {Object} _ReadyStateEvent
 * @property {number} readyState
 */
/**
 * @typedef {Event & _SSEvent} SSEvent
 */
/**
 * @typedef {SSEvent & _ReadyStateEvent} ReadyStateEvent
 */
/**
 * @callback AddEventListener
 * @param {string} type
 * @param {function} listener
 * @returns {void}
 */
/**
 * @callback RemoveEventListener
 * @param {string} type
 * @param {function} listener
 * @returns {void}
 */
/**
 * @callback DispatchEvent
 * @param {string} type
 * @param {function} listener
 * @returns {boolean}
 */
/**
 * @callback Stream
 * @returns {void}
 */
/**
 * @callback Close
 * @returns {void}
 */
/**
 * @callback OnMessage
 * @param {SSEvent} event
 * @returns {void}
 */
/**
 * @callback OnOpen
 * @param {SSEvent} event
 * @returns {void}
 */
/**
 * @callback OnLoad
 * @param {SSEvent} event
 * @returns {void}
 */
/**
 * @callback OnReadystatechange
 * @param {ReadyStateEvent} event
 * @returns {void}
 */
/**
 * @callback OnError
 * @param {SSEvent} event
 * @returns {void}
 */
/**
 * @callback OnAbort
 * @param {SSEvent} event
 * @returns {void}
 */
/**
 * @typedef {Object} SSE
 * @property {string} headers - headers
 * @property {string} payload - payload as a string
 * @property {string} method - HTTP Method
 * @property {boolean} withCredentials - flag, if credentials needed
 * @property {boolean} debug - debugging flag
 * @property {AddEventListener} addEventListener
 * @property {RemoveEventListener} removeEventListener
 * @property {DispatchEvent} dispatchEvent
 * @property {Stream} stream
 * @property {Close} close
 * @property {OnMessage} onmessage
 * @property {OnOpen} onopen
 * @property {OnLoad} onload
 * @property {OnReadystatechange} onreadystatechange
 * @property {OnError} onerror
 * @property {OnAbort} onabort
 */
