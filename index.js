var express = require('express'),
    http = require('http'),
    app = express(),
    WebSocketServer = require('ws').Server,
    WebSocket = require('ws').WebSocket,
    stream = require('stream'),
    Readable = stream.Readable,
    Writable = stream.Writable,
    Transform = stream.Transform,
    util = require('util');

var BUFFER_LENGTH = 256,
    SAMPLE_RATE = 44100;

var CVIn = function() {
  this.values = [];
  Writable.call(this);
};
util.inherits(CVIn, Writable);
CVIn.prototype._write = function(chunk, encoding, cb) {
  var self = this;
  this.values.push(chunk);
  setTimeout(function() {
    cb();
  }, BUFFER_LENGTH / SAMPLE_RATE * 1000);
};
CVIn.prototype.getChunk = function() {
  if (this.values.length > 0) {
    return this.values.shift();
  }
  return null;
};

var SinOsc = function(freq) {
  this.phase = 0;
  this.freq = freq;
  this.mod = 0;
  this.depth = 0;
  this.cvin = new CVIn();
  this.samplerate = SAMPLE_RATE;
  Readable.call(this);
};
util.inherits(SinOsc, Readable);
SinOsc.prototype._read = function(n) {
  var self = this;
  setImmediate(function() {
    self.process();
  });
};
SinOsc.prototype.process = function() {
  var self = this,
      view = new DataView(new ArrayBuffer(BUFFER_LENGTH * 4)),
      cvView,
      cvChunk = this.cvin.getChunk(),
      offset = 0, i, cvval = 0, val;

  if (cvChunk) {
    cvView = new DataView(new Uint8Array(cvChunk).buffer);
  }
  for (i = 0; i < BUFFER_LENGTH; i++) {
    if (cvView) {
      cvval = cvView.getFloat32(offset);
    }
    val = self.generate(cvval);
    view.setFloat32(offset, val);
    offset += 4;
  }

  var buffer = new Buffer(new Uint8Array(view.buffer));
  if (this.push(buffer)) {
    setImmediate(function() {
      self.process();
    });
  }
};
SinOsc.prototype.generate = function(cvval) {
  var val = Math.sin(Math.PI * 2 * this.phase),
      step = (this.freq + (cvval * this.depth)) / this.samplerate;
  this.phase += step;
  return val;
};

var VCA = function(gain) {
  this.gain = gain;
  this.cvin = new CVIn();
  Transform.call(this);
};
util.inherits(VCA, Transform);
VCA.prototype._transform = function(chunk, encoding, cb) {
  var self = this;
  this.push(self.process(chunk));
  cb(null);
};
VCA.prototype._flush = function(output, cb) {
  cb(null);
};
VCA.prototype.process = function(input) {
  var self = this,
      srcView = new DataView(new Uint8Array(input).buffer),
      dstView = new DataView(new ArrayBuffer(BUFFER_LENGTH * 4)),
      cvView,
      cvChunk = this.cvin.getChunk(),
      offset = 0, cvval = 0;

  if (cvChunk) {
    cvView = new DataView(new Uint8Array(cvChunk).buffer);
  }
  for (var i = 0; i < BUFFER_LENGTH; i++) {
    if (cvView) {
      cvval = cvView.getFloat32(offset);
    }
    dstView.setFloat32(offset, srcView.getFloat32(offset) * self.gain * cvval);
    offset += 4;
  }
  return new Buffer(new Uint8Array(dstView.buffer));
};


var Envelope = function(a, d, s, st, r) {
  this.samplerate = SAMPLE_RATE;
  this.attack = a;
  this.decay = d;
  this.sustain = s;
  this.sustainTime = st;
  this.st = 0;
  this.release = r;
  this.current = -1;
  this.start = -1;
  this.value = 0;
  this.state = "none";
  Readable.call(this);
};

util.inherits(Envelope, Readable);
Envelope.prototype._read = function(n) {
  var self = this;
  setImmediate(function() {
    self.process();
  });
};
Envelope.prototype.trigger = function() {
  this.state = "attack";
  this.value = 0;
  this.st = 0;
};
Envelope.prototype.process = function() {
  var self = this,
      curent = (new Date()).getTime(),
      view = new DataView(new ArrayBuffer(BUFFER_LENGTH * 4)),
      offset = 0, i, val;
  for (i = 0; i < BUFFER_LENGTH; i++) {
    val = self.generate();
    view.setFloat32(offset, val);
    offset += 4;
  }

  var buffer = new Buffer(new Uint8Array(view.buffer));
  if (this.push(buffer)) {
    setImmediate(function() {
      self.process();
    });
  }
};
Envelope.prototype.generate = function() {
  var funcs = {
    "attack": function() {
      this.value += 1000 / this.samplerate / this.attack;
      if (this.value >= 1) {
        this.state = "decay";
      }
    },
    "decay": function() {
      this.value -= 1000 / this.samplerate / this.decay * this.sustain;
      if (this.value <= this.sustain) {
        this.state = "sustain";
      }
    },
    "sustain": function() {
      this.value = this.sustain;
	  if (this.st++ >= this.samplerate * 0.001 * this.sustainTime) {
		this.st = 0;
		this.state = "release";
	  }
    },
    "release": function() {
      this.value -= 1000 / this.samplerate / this.release;
      if (this.value <= 0) {
        this.value = 0;
        this.state = "none";
      }
    },
    "none": function() {
      this.value = 0;
    }
  };
  var func = funcs[this.state];
  if (func) func.apply(this);
  return this.value;
};


/*
 * SynthServer
 */
var SynthServer = function() {
  var self = this;
  Transform.call(this);
};
util.inherits(SynthServer, Transform);

SynthServer.prototype._transform = function(chunk, encoding, cb) {
  var self = this;
  this.push(self.process(chunk));
  cb(null);
};
SynthServer.prototype._flush = function(output, cb) {
  cb(null);
};
SynthServer.prototype.process = function(input) {
  var self = this,
      view = new DataView(new ArrayBuffer(BUFFER_LENGTH * 4)),
      offset = 0, i;
  for (i = 0; i < BUFFER_LENGTH; i++) {
    var val = input.readFloatLE(i);
    view.setFloat32(offset, val);
    offset += 4;
  }
  return input;//new Buffer(new Uint8Array(view.buffer));
};

/*
 * SocketWriter
 */
var SocketWriter = function() {
  var self = this;
  Writable.call(self);
  self.sockets = [];
  self.chunks = [];
};
util.inherits(SocketWriter, Writable);
SocketWriter.prototype._write = function(chunk, encoding, cb) {
  var self = this;
  //this.chunks.push(chunk);
  self.sockets.forEach(function(s) {
      setImmediate(function() {
        if (s.readyState === 1) {
          s.send(chunk, {binary: true, mask: false});
        }
      });
  });

  setTimeout(function() {
    // var c = self.chunks.shift();
    // self.sockets.forEach(function(s) {
    //   if (s.readyState === 1) {
    //     s.send(c, {binary: true, mask: false});
    //   }
    // });
    cb();
  }, BUFFER_LENGTH / SAMPLE_RATE * 1000);
};
SocketWriter.prototype.add = function(ws) {
  this.sockets.push(ws);
  console.log("SocketWriter::add", "current conections:", this.sockets.length);
};
SocketWriter.prototype.remove = function(ws) {
  this.sockets.forEach(function(s, i, l) {
    if (s === ws) l.splice(i, 1);
  });
  console.log("SocketWriter::remove", "current conections:", this.sockets.length);
};
SocketWriter.prototype.sendMessage = function(json, src) {
  this.sockets.forEach(function(s) {
    if (src !== s) {
      s.send(JSON.stringify(json));
    }
  });
};

var Sequencer = function(cb) {
  var self = this;
  this.maxStep = 16;
  this.gate = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  this.note = [48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48];
  this.step = 0;
  this.bpm = 120;
  this.prevTime = (new Date).getTime();
  this.running = false;
  this.callback = cb;
  this.timer = setInterval(function() {
    self.process();
  }, 1);
};
Sequencer.prototype.start = function() {
  this.step = 0;
  this.running = true;
};
Sequencer.prototype.stop = function() {
  this.step = 0;
  this.running = false;
};
Sequencer.prototype.resume = function() {
  this.running = true;
};
Sequencer.prototype.suspend = function() {
  this.running = false;
};
Sequencer.prototype.reset = function() {
  this.step = 0;
};
Sequencer.prototype.process = function() {
  var current, ms;
  if (!this.running) return;
  current = (new Date()).getTime();
  ms = (60 * 100) / this.bpm;

  if (this.prevTime + ms < current) {
    this.step = (this.step < this.maxStep - 1) ? this.step + 1 : 0;
    if (this.callback) this.callback.apply(this, [this.step, this.gate[this.step], this.note[this.step]]);
    this.prevTime = current;
  }
};

var midi2freq = function(note) {
  return 440.0 * Math.pow(2.0, (note - 69.0) / 12.0);
};

var vco = new SinOsc(1000),
    lfo = new SinOsc(0.5),
    vca = new VCA(1),
    env = new Envelope(10, 10, 0.9, 100, 50),
    synth = new SynthServer(),
    seq = new Sequencer(function(step, gate, note) {
      if (gate === 1) {
        var freq = midi2freq(note);
        env.trigger();
        vco.freq = freq;
      }
      //writer.sendMessage({message: "step", value: step});
    }),
    writer = new SocketWriter();

lfo.pipe(vco.cvin);
env.pipe(vca.cvin);
vco.pipe(vca).pipe(synth).pipe(writer);

seq.start();

var server = http.createServer(app),
    socket = new WebSocketServer({server:server, path:'/socket'});
socket.on('connection', function(ws) {
  console.log('connect!!');
  writer.add(ws);

  ws.send(JSON.stringify(
    {message: "init", data: {
      "freq": vco.freq,
      "lfo": lfo.freq,
      "depth": vco.depth,
      "attack": env.attack,
      "decay": env.decay,
      "sustain": env.sustain,
      "sustainTime": env.sustainTime,
      "release": env.release,
      "seqonoff": seq.running,
      "bpm": seq.bpm,
      "gate": seq.gate,
      "note": seq.note
    }}
  ));
  ws.on('message', function(req, flags) {
    if (!flags.binary) {
      var data = JSON.parse(req),
          message = data.message,
          value = data.value,
          send = {};
      if (message === 'freq') {
        var freq = data.value;
        vco.freq = freq;
      } else if (message === 'lfo') {
        var freq = data.value;
        lfo.freq = freq;
      } else if (message === 'depth') {
        var depth = data.value;
        vco.depth = depth;
      } else if (message === 'attack') {
        env.attack = data.value;
      } else if (message === 'decay') {
        env.decay = data.value;
      } else if (message === 'sustain') {
        env.sustain = data.value;
      } else if (message === 'sustainTime') {
        env.sustainTime = data.value;
      } else if (message === 'release') {
        env.release = data.value;
      } else if (message === 'trigger') {
        vco.freq = data.value;
        env.trigger();
      } else if (message === 'seq') {
        if (data.gate) {
          seq.gate[data.gate.index] = data.gate.value ? 1 : 0;
          console.log(seq.gate);
        }
        if (data.note) {
          seq.note[data.note.index] = data.note.value;
          console.log(seq.note);
        }
      } else if (message === 'seqonoff') {
        if (data.value) {
          seq.start();
        } else {
          seq.stop();
        }
      } else if (message === 'bpm') {
        seq.bpm = data.value;
      }
      writer.sendMessage(data, ws);
    }
  });

  ws.on('close', function() {
    console.log('close');
    writer.remove(ws);
  });

  ws.on('e', function(e) {
    console.log('error:', e);
  });
});

app.configure(function(){
  app.set('views', __dirname + '/views');
  app.set('view engine', 'ejs');
  app.use(express.bodyParser());
  app.use(express.methodOverride());
  app.use(express.cookieParser());
  app.use(app.router);
  app.use(express.static(__dirname + '/public'));
});
app.configure('development', function(){
  app.use(express.errorHandler({ dumpExceptions: true, showStack: true }));
});
app.configure('production', function(){
  app.use(express.errorHandler());
});
app.get('/', function(req, res){
  res.render('index');
});


var port = process.env.PORT || 5000;

server.listen(port, function() {
  console.log("Listening on " + port);
});

