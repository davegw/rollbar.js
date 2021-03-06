var _ = require('../utility');
var urlparser = require('./url');

var defaults = {
  network: true,
  log: true,
  dom: true,
  navigation: true,
  connectivity: true
};

function replace(obj, name, replacement, replacements) {
  var orig = obj[name];
  obj[name] = replacement(orig);
  if (replacements) {
    replacements.push([obj, name, orig]);
  }
}

function restore(replacements) {
  var b;
  while (replacements.length) {
    b = replacements.shift();
    b[0][b[1]] = b[2];
  }
}

function Instrumenter(options, telemeter, rollbar, _window, _document) {
  var autoInstrument = options.autoInstrument;
  if (autoInstrument === false) {
    this.autoInstrument = {};
    return;
  }
  if (!_.isType(autoInstrument, 'object')) {
    autoInstrument = defaults;
  }
  this.autoInstrument = _.extend(true, {}, defaults, autoInstrument);
  this.telemeter = telemeter;
  this.rollbar = rollbar;
  this._window = _window || {};
  this._document = _document || {};
  this.replacements = [];

  this._location = this._window.location;
  this._lastHref = this._location && this._location.href;
}

Instrumenter.prototype.instrument = function() {
  if (this.autoInstrument.network) {
    this.instrumentNetwork();
  }

  if (this.autoInstrument.log) {
    this.instrumentConsole();
  }

  if (this.autoInstrument.dom) {
    this.instrumentDom();
  }

  if (this.autoInstrument.navigation) {
    this.instrumentNavigation();
  }

  if (this.autoInstrument.connectivity) {
    this.instrumentConnectivity();
  }
};

Instrumenter.prototype.instrumentNetwork = function() {
  var self = this;

  function wrapProp(prop, xhr) {
    if (prop in xhr && _.isFunction(xhr[prop])) {
      replace(xhr, prop, function(orig) {
        return self.rollbar.wrap(orig);
      }, self.replacements);
    }
  }

  if ('XMLHttpRequest' in this._window) {
    var xhrp = this._window.XMLHttpRequest.prototype;
    replace(xhrp, 'open', function(orig) {
      return function(method, url) {
        if (_.isType(url, 'string')) {
          this.__rollbar_xhr = {
            method: method,
            url: url,
            status_code: null,
            start_time_ms: _.now(),
            end_time_ms: null
          };
        }
        return orig.apply(this, arguments);
      };
    }, this.replacements);

    replace(xhrp, 'send', function(orig) {
      /* eslint-disable no-unused-vars */
      return function(data) {
      /* eslint-enable no-unused-vars */
        var xhr = this;

        function onreadystatechangeHandler() {
          if (xhr.__rollbar_xhr && (xhr.readyState === 1 || xhr.readyState === 4)) {
            if (xhr.__rollbar_xhr.status_code === null) {
              xhr.__rollbar_xhr.status_code = 0;
              xhr.__rollbar_event = self.telemeter.captureNetwork(xhr.__rollbar_xhr, 'xhr');
            }
            if (xhr.readyState === 1) {
              xhr.__rollbar_xhr.start_time_ms = _.now();
            } else {
              xhr.__rollbar_xhr.end_time_ms = _.now();
            }
            try {
              var code = xhr.status;
              code = code === 1223 ? 204 : code;
              xhr.__rollbar_xhr.status_code = code;
              xhr.__rollbar_event.level = self.telemeter.levelFromStatus(code);
            } catch (e) {
              /* ignore possible exception from xhr.status */
            }
          }
        }

        wrapProp('onload', xhr);
        wrapProp('onerror', xhr);
        wrapProp('onprogress', xhr);

        if ('onreadystatechange' in xhr && _.isFunction(xhr.onreadystatechange)) {
          replace(xhr, 'onreadystatechange', function(orig) {
            return self.rollbar.wrap(orig, undefined, onreadystatechangeHandler);
          });
        } else {
          xhr.onreadystatechange = onreadystatechangeHandler;
        }
        return orig.apply(this, arguments);
      }
    }, this.replacements);
  }

  if ('fetch' in this._window) {
    replace(this._window, 'fetch', function(orig) {
      /* eslint-disable no-unused-vars */
      return function(fn, t) {
      /* eslint-enable no-unused-vars */
        var args = new Array(arguments.length);
        for (var i=0, len=args.length; i < len; i++) {
          args[i] = arguments[i];
        }
        var input = args[0];
        var method = 'GET';
        var url;
        if (_.isType(input, 'string')) {
          url = input;
        } else {
          url = input.url;
          if (input.method) {
            method = input.method;
          }
        }
        if (args[1] && args[1].method) {
          method = args[1].method;
        }
        var metadata = {
          method: method,
          url: url,
          status_code: null,
          start_time_ms: _.now(),
          end_time_ms: null
        };
        self.telemeter.captureNetwork(metadata, 'fetch');
        return orig.apply(this, args).then(function (resp) {
          metadata.end_time_ms = _.now();
          metadata.status_code = resp.status;
          return resp;
        });
      };
    }, this.replacements);
  }
};

Instrumenter.prototype.instrumentConsole = function() {
  if (!('console' in this._window && this._window.console.log)) {
    return;
  }

  var self = this;
  var c = this._window.console;

  function wrapConsole(method) {
    var orig = c[method];
    var origConsole = c;
    var level = method === 'warn' ? 'warning' : method;
    c[method] = function() {
      var args = Array.prototype.slice.call(arguments);
      var message = _.formatArgsAsString(args);
      self.telemeter.captureLog(message, level);
      if (orig) {
        Function.prototype.apply.call(orig, origConsole, args);
      }
    };
  }
  var methods = ['debug','info','warn','error','log'];
  for (var i=0, len=methods.length; i < len; i++) {
    wrapConsole(methods[i]);
  }
};

Instrumenter.prototype.instrumentDom = function() {
  if (!('addEventListener' in this._window || 'attachEvent' in this._window)) {
    return;
  }
  var clickHandler = this.handleClick.bind(this);
  var blurHandler = this.handleBlur.bind(this);
  if (this._window.addEventListener) {
    this._window.addEventListener('click', clickHandler, true);
    this._window.addEventListener('blur', blurHandler, true);
  } else {
    this._window.attachEvent('click', clickHandler);
    this._window.attachEvent('onfocusout', blurHandler);
  }
};

Instrumenter.prototype.handleClick = function(evt) {
  try {
    var e = getElementFromEvent(evt, this._document);
    var hasTag = e && e.tagName;
    var anchorOrButton = isDescribedElement(e, 'a') || isDescribedElement(e, 'button');
    if (hasTag && (anchorOrButton || isDescribedElement(e, 'input', ['button', 'submit']))) {
        this.captureDomEvent('click', e);
    } else if (isDescribedElement(e, 'input', ['checkbox', 'radio'])) {
      this.captureDomEvent('input', e, e.value, e.checked);
    }
  } catch (exc) {
    // TODO: Not sure what to do here
  }
};

Instrumenter.prototype.handleBlur = function(evt) {
  try {
    var e = getElementFromEvent(evt, this._document);
    if (e && e.tagName) {
      if (isDescribedElement(e, 'textarea')) {
        this.captureDomEvent('input', e, e.value);
      } else if (isDescribedElement(e, 'select') && e.options && e.options.length) {
        this.handleSelectInputChanged(e);
      } else if (isDescribedElement(e, 'input') && !isDescribedElement(e, 'input', ['button', 'submit', 'hidden', 'checkbox', 'radio'])) {
        this.captureDomEvent('input', e, e.value);
      }
    }
  } catch (exc) {
    // TODO: Not sure what to do here
  }
};

Instrumenter.prototype.handleSelectInputChanged = function(elem) {
  if (elem.multiple) {
    for (var i = 0; i < elem.options.length; i++) {
      if (elem.options[i].selected) {
        this.captureDomEvent('input', elem, elem.options[i].value);
      }
    }
  } else if (elem.selectedIndex >= 0 && elem.options[elem.selectedIndex]) {
    this.captureDomEvent('input', elem, elem.options[elem.selectedIndex].value);
  }
};

Instrumenter.prototype.captureDomEvent = function(subtype, element, value, isChecked) {
  if (getElementType(element) === 'password') {
    value = undefined;
  }
  var elementString = elementArrayToString(treeToArray(element));
  this.telemeter.captureDom(subtype, elementString, value, isChecked);
};

function getElementType(e) {
  return (e.getAttribute('type') || '').toLowerCase();
}

function isDescribedElement(element, type, subtypes) {
  if (element.tagName.toLowerCase() !== type.toLowerCase()) {
    return false;
  }
  if (!subtypes) {
    return true;
  }
  element = getElementType(element);
  for (var i = 0; i < subtypes.length; i++) {
    if (subtypes[i] === element) {
      return true;
    }
  }
  return false;
}

function getElementFromEvent(evt, doc) {
  if (evt.target) {
    return evt.target;
  }
  if (doc && doc.elementFromPoint) {
    return doc.elementFromPoint(evt.clientX, evt.clientY);
  }
  return undefined;
}

function treeToArray(elem) {
  var MAX_HEIGHT = 5;
  var out = [];
  var nextDescription;
  for (var height = 0; elem && height < MAX_HEIGHT; height++) {
    nextDescription = describeElement(elem);
    if (nextDescription.tagName === 'html') {
      break;
    }
    out.push(nextDescription);
    elem = elem.parentNode;
  }
  return out.reverse();
}

function elementArrayToString(a) {
  var MAX_LENGTH = 80;
  var separator = ' > ', separatorLength = separator.length;
  var out = [], len = 0, nextStr, totalLength;

  for (var i = 0; i < a.length; i++) {
    nextStr = descriptionToString(a[i]);
    totalLength = len + (out.length * separatorLength) + nextStr.length;
    if (i > 0 && totalLength >= MAX_LENGTH) {
      break;
    }
    out.push(nextStr);
    len += nextStr.length;
  }
  return out.join(separator);
}

/**
 * Old implementation
 * Should be equivalent to: elementArrayToString(treeToArray(elem))
function treeToString(elem) {
  var MAX_HEIGHT = 5, MAX_LENGTH = 80;
  var separator = ' > ', separatorLength = separator.length;
  var out = [], len = 0, nextStr, totalLength;

  for (var height = 0; elem && height < MAX_HEIGHT; height++) {
    nextStr = elementToString(elem);
    if (nextStr === 'html') {
      break;
    }
    totalLength = len + (out.length * separatorLength) + nextStr.length;
    if (height > 1 && totalLength >= MAX_LENGTH) {
      break;
    }
    out.push(nextStr);
    len += nextStr.length;
    elem = elem.parentNode;
  }
  return out.reverse().join(separator);
}

function elementToString(elem) {
  return descriptionToString(describeElement(elem));
}
 */

function descriptionToString(desc) {
  if (!desc || !desc.tagName) {
    return '';
  }
  var out = [desc.tagName];
  if (desc.id) {
    out.push('#' + desc.id);
  }
  if (desc.classes) {
    out.push('.' + desc.classes.join('.'));
  }
  for (var i = 0; i < desc.attributes.length; i++) {
    out.push('[' + desc.attributes[i].key + '="' + desc.attributes[i].value + '"]');
  }

  return out.join('');
}

/**
 * Input: a dom element
 * Output: null if tagName is falsey or input is falsey, else
 *  {
 *    tagName: String,
 *    id: String | undefined,
 *    classes: [String] | undefined,
 *    attributes: [
 *      {
 *        key: OneOf(type, name, title, alt),
 *        value: String
 *      }
 *    ]
 *  }
 */
function describeElement(elem) {
  if (!elem || !elem.tagName) {
    return null;
  }
  var out = {}, className, key, attr, i;
  out.tagName = elem.tagName.toLowerCase();
  if (elem.id) {
    out.id = elem.id;
  }
  className = elem.className;
  if (className && _.isType(className, 'string')) {
    out.classes = className.split(/\s+/);
  }
  var attributes = ['type', 'name', 'title', 'alt'];
  out.attributes = [];
  for (i = 0; i < attributes.length; i++) {
    key = attributes[i];
    attr = elem.getAttribute(key);
    if (attr) {
      out.attributes.push({key: key, value: attr});
    }
  }
  return out;
}

Instrumenter.prototype.instrumentNavigation = function() {
  var chrome = this._window.chrome;
  var chromePackagedApp = chrome && chrome.app && chrome.app.runtime;
  // See https://github.com/angular/angular.js/pull/13945/files
  var hasPushState = !chromePackagedApp && this._window.history && this._window.history.pushState;
  if (!hasPushState) {
    return;
  }
  var self = this;
  var oldOnPopState = this._window.onpopstate;
  this._window.onpopstate = function() {
    var current = self._location.href;
    self.handleUrlChange(self._lastHref, current);
    if (oldOnPopState) {
      oldOnPopState.apply(this, arguments);
    }
  };

  replace(this._window.history, 'pushState', function(orig) {
    return function() {
      var url = arguments.length > 2 ? arguments[2] : undefined;
      if (url) {
        self.handleUrlChange(self._lastHref, url + '');
      }
      return orig.apply(this, arguments);
    };
  }, this.replacements);
};

Instrumenter.prototype.handleUrlChange = function(from, to) {
  var parsedHref = urlparser.parse(this._location.href);
  var parsedTo = urlparser.parse(to);
  var parsedFrom = urlparser.parse(from);
  this._lastHref = to;
  if (parsedHref.protocol === parsedTo.protocol && parsedHref.host === parsedTo.host) {
    to = parsedTo.path + (parsedTo.hash || '');
  }
  if (parsedHref.protocol === parsedFrom.protocol && parsedHref.host === parsedFrom.host) {
    from = parsedFrom.path + (parsedFrom.hash || '');
  }
  this.telemeter.captureNavigation(from, to);
};

Instrumenter.prototype.instrumentConnectivity = function() {
  if (!('addEventListener' in this._window || 'body' in this._document)) {
    return;
  }
  if (this._window.addEventListener) {
    this._window.addEventListener('online', function() {
      this.telemeter.captureConnectivityChange('online');
    }.bind(this), true);
    this._window.addEventListener('offline', function() {
      this.telemeter.captureConnectivityChange('offline');
    }.bind(this), true);
  } else {
    this._document.body.ononline = function() {
      this.telemeter.captureConnectivityChange('online');
    }.bind(this);
    this._document.body.onoffline = function() {
      this.telemeter.captureConnectivityChange('offline');
    }.bind(this);
  }
};

Instrumenter.prototype.restore = function() {
  restore(this.replacements);
  this.replacements = [];
};

module.exports = Instrumenter;
