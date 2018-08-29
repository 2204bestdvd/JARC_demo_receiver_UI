var fs = require('fs');
var express = require('express');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var ReedSolomon = require('./ReedSolomon').ReedSolomon;
var port = 8080;

/********
 * Create serial port connection
 ********/

// Serial port settings
var serial = require("serialport");
var portNameCli = "COM4";
var portNameData = "COM5";
if (process.argv.length > 2) {
    var portNameCli = process.argv[2];
    if (process.argv.length > 3) {
        var portNameData = process.argv[3];
    } else {
        console.log("Data port not supplied, use default COM5");
    }   
} else {
    console.log("Config port not supplied, use default COM4");
    console.log("Data port not supplied, use default COM5");
}

// Start serial ports

var serialPortCli = new serial(portNameCli, {
    baudRate: 115200,
    autoOpen: true,
});

var serialPortData = new serial(portNameData, {
    baudRate: 115200,
    autoOpen: true,
});

// Serial port parsers
var logCli = false;
var logData = false;
var initialized = false;

const Readline = serial.parsers.Readline;

var parserCli = new Readline();
serialPortCli.pipe(parserCli);

serialPortCli.on("open", function () {
    console.log('open cli port');
});
parserCli.on('data', function (data) {
    console.log(data);
    if (logCli) {
        io.emit('log', data);
    }
});  


var parserData = new Readline();
serialPortData.pipe(parserData);

serialPortData.on("open", function () {
    console.log('open data port');
});
parserData.on('data', function(data) {
    console.log(data);

    processData(data);
});


 // Read input from console and send through serial port
var stdin = process.openStdin();
stdin.addListener("data", function(d) {
    serialPortCli.write(d);
});


/********
 * Handle client request
 ********/

app.get('/index.html', function (req, res) {
    res.sendFile( __dirname + "/" + "index.html" );
})
app.get('/', function (req, res) {
    res.sendFile( __dirname + "/" + "index.html" );
})

app.use(express.static('public'));



http.listen(port, 'localhost', function(){
    console.log('listening on ' + http.address().address + ':' + port);
});


io.on('connection', function(socket){
    console.log('a user connected');

    socket.on('disconnect', function(socket){
        console.log('user disconnected');
    });
    
    if (!initialized) {
        initLoadCli(defaultCfgFilename);
    }
});

      

/********
 * Config file handling
 ********/

var defaultCfgFilename = '../AWR1642\ Application/mmwave_sdk_01_01_00_02/demo/profiles'
                        + '/transmitter/profile_fft_test_hw_trigger_chirp_128_slope_1_rx.cfg';
function initLoadCli(filename) {
    // Automatically select the mode
    serialPortCli.write('\n');

    var lines;
    fs.readFile(filename, 'utf8', function(err, data) {
        lines = data.split('\n');
    });

    var commandPause = 100;
    setTimeout(function() { 
        serialPortCli.write('3');
        serialPortCli.write('\n'); 

        var line = 0;
        var sendAndWait = function(){
            if (line < lines.length) {
                //console.log('message: ' + lines[line]);
                serialPortCli.write(lines[line] + '\n');
        
                line++;
                setTimeout(sendAndWait, commandPause);                
            }
        }

        sendAndWait();
    }, commandPause);

    initialized = true;
}

/********
 * Demodulation and data buffer
 ********/

var buffer = [];

// Reed Solomon codec
var numRedundant = 20;
var rs = new ReedSolomon(numRedundant);

function parseByteData(data) {
    data = data.split(',').map(Number);
    // Clean up trailing zero due to extra delimiter at the end
    data.pop();

    io.emit('log', data.toString());   


    buffer = buffer.concat(data);
    io.emit('buffer', buffer.length);    
}

function parseSymbolData(data) {
    data = data.split(',').map(Number);
    // Clean up trailing zero due to extra delimiter at the end
    data.pop();

    var i;

    for (i = 0; i < 4; i++) {
        if (data[i] !== i) {
            io.emit('log', 'Header not matched');
            return;
            //break;
        }
    }

    data = data.slice(4);

    var numByte = 0;
    for (i = 0; i < 4; i++) {
        numByte += data[i] * (1<<(2*i));
    }
    if (logData) {
        io.emit('log', 'Received ' + numByte + ' bytes');
    }
    data = data.slice(4);

    var bytes = [];
    var byte = 0;
    while (data.length>0) {
        if (data.length < 4) break;

        byte = 0;
        for (i = 0; i < 4; i++) {
            byte += data[i] * (1<<(2*i));
        }
        bytes.push(byte);

        data = data.slice(4);
    }
    //if (logData) {
    io.emit('log', bytes.toString());   
    //}

    /*
    // number of bytes error
    if (numByte > bytes.length) {
        return;
    }
    */
   /*
    // Correct number of bytes error (Note: may need to modify later)
    if (numByte > bytes.length) {
        numByte = bytes.length;
    } else if (numByte < bytes.length) {
        while(numByte < bytes.length) {
            // If excess bytes are nonzero, assume number of bytes error and include those bytes
            if (bytes[numByte] === 0) {
                break;
            }
            numByte++;
        }
        io.emit('log', 'Correcting number of bytes to ' + numByte);
    }
    */
    // Simply set number of bytes according to received bytes (Eliminate redundant zeros in data queue)
    //numByte = bytes.length;
    
            
    buffer = buffer.concat(bytes.slice(0, numByte));
    //io.emit('buffer', buffer.toString());
    io.emit('buffer', buffer.length);
}



function processData(data) {
    if (data.length > 1 && data[1] === '*') {
        return;
    }

    if (logData) {
        io.emit('log', data);
    }

    //parseSymbolData(data);
    parseByteData(data);

    processBuffer();
}

function processBuffer() {
    // File header length of 6 bytes: [1, 255, length(4 bytes)]
    while (buffer.length > 6) {
        // Remove the trailing zeros
        if (buffer[0] === 0) {
            buffer.shift(1);
            continue;
        }

        var packetLength = 0;
        for (var i = 0; i < 4; i++) {
            packetLength = (packetLength << 8) + buffer[i+2];
        }

        var totalLength = (packetLength+6) + Math.ceil((packetLength+6) / (255 - numRedundant)) * numRedundant;

        // Sanity check
        if (totalLength < 0) {
            return;
        }

        if (buffer.length < totalLength) {
            break;
        } else {
            data = buffer.slice(0, totalLength);
            buffer = buffer.slice(totalLength);


            fs.writeFile('debug_received.txt', data, function(err){});

            try {
                var msg = rs.decodeByte(data);

                // Remove header
                msg = msg.slice(6);

                //console.log(msg);
                io.emit('buffer', msg.toString());

                // Save received file
                //var filename = 'public/test.png';
                var folder = 'public/';
                var filename = getAvailableFilename(folder, 'test', '.png');
                var buf = new Buffer(msg, 'base64');
                fs.writeFile(folder + filename, buf, function(err) {
                    if (err) {
                        return console.log(err);
                    }
                    console.log("File saved");
                    io.emit('image', filename);
                });

            } catch (e) {
                console.log(e);
            }
        }


    }
}

function getAvailableFilename(folder, filename, extension, count = 0) {
    if (count > 0) {
        suffixFilename = filename + '_' + count;
    } else {
        suffixFilename = filename;
    }
    if (fs.existsSync(folder + suffixFilename + extension)) {
        return getAvailableFilename(folder, filename, extension, count+1);
    } else {
        return suffixFilename + extension;
    }
}


