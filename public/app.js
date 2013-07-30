(function() {
  var host = window.location.href.replace(/(http|https)(:\/\/.*?)\/.*/, 'ws$2'),
      socket = new WebSocket(host + '/socket'),
      BUFFER_LENGTH = 2048,
      ctx = new webkitAudioContext();

  var AudioListener = function(ctx, bufferLength) {
    var self = this;
    this.ctx = ctx;
    this.bufferLength = bufferLength;
    this.chNum = 2;
    this.listenBuffers = [];

    this.processNode = ctx.createJavaScriptNode(this.bufferLength, 2, 2);
    this.processNode.onaudioprocess = function(e) {
      if (self.listenBuffers.length > 0) {
        var currentBuffer = self.listenBuffers.shift();
        var bufferL = (currentBuffer[0] || new Float32Array(self.bufferLength));
        var bufferR = (currentBuffer[1] || new Float32Array(self.bufferLength));
        e.outputBuffer.getChannelData(0).set(bufferL);
        e.outputBuffer.getChannelData(1).set(bufferR);
      }
    };
  };
  AudioListener.prototype = {
    setAudioBuffer: function(buffer) {
      var view = new DataView(buffer);
      var streamBuffer = new Array(this.chNum);
      var offset = 0;
      for (var i = 0; i < this.chNum; i++) {
        streamBuffer[i] = new Float32Array(this.bufferLength);
        for (var j = 0; j < this.bufferLength; j++) {
          streamBuffer[i][j] = view.getFloat32(offset);
          offset += 4;
        }
      }
      this.listenBuffers.push(streamBuffer);
    },
    connect: function(node) {
      this.processNode.connect(node);
    }
  };

  var Visualizer = function(ctx, canvasName) {
    this.analyserNode = ctx.createAnalyser();
    this.canvas = document.getElementById(canvasName);
    this.ctx = this.canvas.getContext('2d');

    this.resize();

    this.timeDomainByteData = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.freqDomainByteData = new Uint8Array(this.analyserNode.frequencyBinCount);

    this.isAnalyze = false;
    this.animation = function(fn) {
      var requestAnimationFrame = window.requestAnimationFrame ||
        window.webkitRequestAnimationFrame ||
        window.mozRequestAnimationFrame;
      requestAnimationFrame(fn);
    };
    var self = this;
    this.analyze = function() {
      self.analyserNode.getByteTimeDomainData(self.timeDomainByteData);
      self.analyserNode.getByteFrequencyData(self.freqDomainByteData);

      self.ctx.clearRect(0, 0, self.canvas.width, self.canvas.height);
      self.ctx.beginPath();
      self.ctx.fillStyle = 'black';
      self.ctx.rect(0, 0, self.canvas.width, self.canvas.height);
      self.ctx.fill();

      self.drawTimeDomain(self.timeDomainByteData);
      self.drawFreqDomain(self.freqDomainByteData);
      if (self.isAnalyze) {
        self.animation(self.analyze);
      }
    };
  };
  Visualizer.prototype = {
    start: function() {
      this.isAnalyze = true;
      this.analyze();
    },
    stop: function() {
      this.isAnalyze = false;
    },
    drawTimeDomain: function(data) {
      var canvas = this.canvas;
      var ctx = this.ctx;

      var value;
      ctx.beginPath();
      ctx.moveTo(0, -999);
      for (var i = 0; i < data.length; i++) {
        value = data[i] - 128 + canvas.height / 2;
            ctx.lineTo(i, value);
      }
      ctx.moveTo(0, 999);
      ctx.closePath();
      ctx.strokeStyle = 'yellow';
      ctx.stroke();
    },
    drawFreqDomain: function(data) {
      var canvas = this.canvas;
      var ctx = this.ctx;

      ctx.beginPath();
      var len = data.length;
      for (var i = 0; i < canvas.width; i++) {
        var index = (len / canvas.width * i) | 0;
        var value = (canvas.height - (data[index] || 0) / 256 * canvas.height) | 0;
        if (i == 0) ctx.moveTo(0, value);
        ctx.lineTo(i + 1, value);
      }
      ctx.strokeStyle = 'blue';
      ctx.stroke();
    },
    connect: function(node) {
      this.analyserNode.connect(node);
    },
    resize: function() {
      this.canvas.width = document.documentElement.clientWidth;
      this.canvas.height = document.documentElement.clientHeight;
    }
  };

  var listener = new AudioListener(ctx, BUFFER_LENGTH);
  var visualizer = new Visualizer(ctx, 'scope-view', 'scope-view');
  var volumeNode = ctx.createGainNode();

  listener.connect(volumeNode);
  volumeNode.connect(visualizer.analyserNode);
  visualizer.connect(ctx.destination);
  visualizer.start();

  //WS Setup
  socket.onopen = function() {
    console.log('onopen');
    socket.binaryType = 'arraybuffer';
  };
  socket.onerror = function() {
    console.log('connection error.');
  };
  socket.onclose = function() {
    console.log('connection close.');
  };
  socket.onmessage = function(message) {
    listener.setAudioBuffer(message.data);
  };

  // Event Setup
  $('#freq').bind('change', function(e){
    socket.send(JSON.stringify({ message: "freq", value: this.valueAsNumber }));
  });
  $('#lfo').bind('change', function(e){
    socket.send(JSON.stringify({ message: "lfo", value: this.valueAsNumber }));
  });
  $('#depth').bind('change', function(e){
    socket.send(JSON.stringify({ message: "depth", value: this.valueAsNumber }));
  });
  $('#volume').bind('change', function(e){
    volumeNode.gain.value = this.valueAsNumber;
  });

  $(window).resize(function(){
    visualizer.resize();
  });
})();
