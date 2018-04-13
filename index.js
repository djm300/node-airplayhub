#!/usr/bin/env node

// Import depencies
var path = require('path');
var fs = require('fs')
const express = require('express');
const Mqtt = require('mqtt');
const log = require('yalm');
const airtunes = require('airtunes')
const airtunesserver = require('nodetunes');
const bonjour = require('bonjour')();
var argv = require('minimist')(process.argv.slice(2));
var app = express();
var http = require('http');


// Set configuration file template
var config = {
    "servername": "[AirPlay Hub]",
    "webuiport": 8089,
    "verbosity": "debug",
    "idletimout": 600,
    "mastervolume": -15,
    "zones": [],
    "mqtt": true,
    "mqttUrl": "mqtt://mXXX.cloudmqtt.com:11111",
    "mqttTopic": "airplayhub",

    "mqttOptions": {
        "host": "mXX.cloudmqtt.com",
        "port": 11111,
        "username": "USER",
        "password": "PASS",
        "clientId": "airplayhub",
        "retain": false
    }
};
var configPath = './config.json';
var mqtt;

// Set up logger
log.setLevel(config.verbosity);

log.info('Application starting');

// Read command line argument and see if there is a config file available - else read ./config.json
if (argv.h || argv.help) {
    console.log('usage: node-airplayhub [options]\n  options:\n    -c, --config     Path to config file')
    process.exit();
} else {
    if (argv.c) configPath = argv.c;
    if (argv.config) configPath = argv.config;
    if (!path.isAbsolute(configPath)) configPath = path.join(__dirname, configPath)
}

// Try to read the config file. It it doesn't exist, create one.
try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    log.debug('Configuration applied: \n' + JSON.stringify(config, null, 2));

} catch (e) {
    log.debug('Configuration could not be found, writing new one');
    // Not doing this - if parsing fails, this will overwrite the config file with a  default
    //    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
}

// define internal variables for speakers
var zones = config.zones;
var connectedDevices = [];
var trackinfo = {};
var idleTimer;

// start device which can stream to other airplay speakers
var server = new airtunesserver({
    serverName: config.servername,
    verbose: false
});


// setup mqtt
if (config.mqtt) {

    log.info('MQT enabled, connecting...');
    log.debug("MQTT Options from config: ", config.mqttOptions);

    var mqttOpts = Object.assign(config.mqttOptions, {
        will: {
            topic: config.mqttTopic + '/status/connected',
            payload: '0',
            retain: true
        }
    });

    log.debug("MQTT URL: ", config.mqttUrl);
    log.debug("MQTT Options: ", mqttOpts);


    mqtt = Mqtt.connect(config.mqttUrl, mqttOpts);

    mqtt.on('connect', () => {
        log.info('mqtt connected', config.mqttUrl);

        mqttPub(config.mqttTopic + '/status/connected', '1', {
            retain: true
        });

        var topic = config.mqttTopic + '/#';
        log.info('mqtt subscribe ' + topic);

        mqtt.subscribe(topic);
    });

    mqtt.on('close', () => {
        log.info('mqtt closed ' + config.mqttUrl);
    });

    mqtt.on('error', err => {
        log.error('mqtt', err.toString());
    });

    mqtt.on('offline', () => {
        log.error('mqtt offline');
    });

    mqtt.on('reconnect', () => {
        log.info('mqtt reconnect');
    });


    /*
        MQTT topics:
    
        airplayhub/status/Keuken/volume - message 10


        airplayhub/set/Keuken/volume - message 10
        -- Must contain message of format int
        airplayhub/set/Keuken/enable - message true or empty
        -- May have no message or message 'true' or message with random value. If message is false, this will be seen as speaker disable request.

        airplayhub/set/Keuken/disable
        -- Regardless of message content, will be considered as disable request.

        airplayhub/get/Keuken/volume or airplayhub/set/Keuken/volume without message
        -- get message: payload ignored, will always return volume
        -- set message: payload required and needs to be int.
        -- in both cases, result will be sent via airplayhub/status/Keuken/volume with an int payload

        For setting the composite volume:
        airplayhub/get/GLOBAL/volume or airplayhub/set/GLOBAL/volume without message
        airplayhub/set/GLOBAL/volume 
        -- get message: payload ignored, will always return global volume
        -- set message: payload required and needs to be int.
        -- in both cases, result will be sent via airplayhub/status/GLOBAL/volume with an int payload
    
        */
    mqtt.on('message', (topic, message) => {
        message = message.toString();
        log.debug('incoming mqtt message < ', topic, message);
        var [ , msgtype, speaker, command] = topic.split('/');

        // If it's a status message, ignore it
        if (_isStatusMessage(msgtype)) {
            log.debug("Status message received: <" + speaker + "> - " + message);
            return;
        }


        // Stop processing if the msgtype is invalid, so not get or set
        if (!(_isValidMessageType(msgtype)))  {
            log.info('message type invalid: ', msgtype);
            return;
        }

        // Stop processing if we don't know this speaker
        if  (!(_isSpeakerKnown(speaker))) {
            log.info('unknown speaker ', speaker);
            return;
        }

        if (_isGlobalVolumeMessage(speaker)) {
            // This request is about GLOBAL volume
            log.info('Request for global volume - ignoring speaker name', speaker);

            // setting global volume
            log.debug("MQTT message received for global volume");
            switch (msgtype) {
                // get global volume
                case 'get':
                   log.debug("MQTT requesting status of global volume");
                   _getCompositeVolume();
                   break;
                // set global volume
                case 'set':
                    log.debug("MQTT requesting SETTING of global volume");
                    _setCompositeVolume(parseInt(message, 10));
                    break;
             }
        }

        let obj;

        switch (command) {
            case 'enable':
                if (message === 'false' || message === '0') {
                    _stopZone(speaker);
                } else if (message === 'true' || parseInt(message, 10) > 0) {
                    _startZone(speaker);
                } else {
                    try {
                        obj = JSON.parse(message);
                        if (obj.val) {
                            _startZone(speaker);
                        } else {
                            _stopZone(speaker);
                        }
                    } catch (err) {
                        _startZone(speaker);
                    }
                }
                break;
            case 'disable':
                _stopZone(speaker);
                break;
            case 'volume':
                        switch (getset) {
                            // get speaker volume
                            case 'get':
                                log.debug("MQTT requesting status of speaker volume");
                                _getVolume(speaker);
                                // set speaker volume
                            case 'set':
                                log.debug("MQTT requesting SETTING of speaker volume");
                                if (isNaN(message)) {
                                    try {
                                        obj = JSON.parse(message);
                                        _setVolume(speaker, obj.val);
                                    } catch (err) {

                                    }
                                } else {
                                    _setVolume(speaker, parseInt(message, 10));
                                }
                                break;
                        }
                }

    });

    function _getVolume(speaker) {
        if (config.mqtt) {
            mqttPub("config.mqttTopic" + "/status/" + speaker + "/volume", "0", {});
        }
    }

    function _setCompositeVolume(volume) {
        if (config.mqtt) {
            mqttPub("config.mqttTopic" + "/status/GLOBAL/volume", "0", {});
        }
    }

    function _getCompositeVolume() {
        if (config.mqtt) {
            mqttPub("config.mqttTopic" + "/status/GLOBAL/volume", "0", {});
        }
    }

}

// debug logging on the airtunes streamer pipeline
airtunes.on('buffer', status => {
    log.debug('buffer', status);
});

// if someone connects to the airplay hub, stream in into the airtunes sink
server.on('clientConnected', function (stream) {
    log.info("New connection on airplayhub");
    clearTimeout(idleTimer);
    stream.pipe(airtunes);
    for (var i in zones) {
        if (zones[i].enabled) {
            log.info("Starting to stream to enabled zone " + zones[i].name);
            connectedDevices[i] = airtunes.add(zones[i].host, {
                port: zones[i].port,
                volume: compositeVolume(zones[i].volume)
            });
        }
    }
});

// if someone disconnects to the airplay hub
server.on('clientDisconnected', (data) => {
    clearTimeout(idleTimer);
    log.info("Client disconnected from airplayhub");
    if (config.idletimout > 0) {
        idleTimer = setTimeout(() => {
            airtunes.stopAll(() => {
                log.info("Stopping stream to all zones");
                for (var i in zones) {
                    zones[i].enabled = false;
                    log.info("Disabled zone " + zones[i].name);
                }
                fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
            });
        }, config.idletimout * 1000);
    }
});


server.on('metadataChange', (data) => {
    log.info("Metadata changed");
    trackinfo = data;
    getArtwork(trackinfo.asar, trackinfo.asal, (url) => {
        if (url) {
            trackinfo.albumart = url;
        } else {
            trackinfo.albumart = '/genericart.png';
        }
    });
});


function compositeVolume(vol) {
    log.debug("Calculating compositeVolume for vol " + vol);
    //    log.debug("Setting volume to "+Math.round(vol*(config.mastervolume+30)/30.));
    return (config.mastervolume == -144 ? 0 :
        Math.round(vol * (config.mastervolume + 30) / 30.));

}

// This is a master change volume coming from the audio source, e.g. your iphone with Spotify. This will take that volume and translate that to a new volume level for every active speaker.
server.on('volumeChange', (data) => {
    log.info("Volume change requested: request master volume " + data);
    config.mastervolume = data; // -30 to 0dB, or -144 for mute
    for (var i in zones) {
        if (zones[i].enabled) {
            connectedDevices[i].setVolume(compositeVolume(zones[i].volume));
            log.info("Set volume for zone " + zones[i].name + " to " + compositeVolume(zones[i].volume));
        }
    }
    clearTimeout(idleTimer);
});

server.start();

app.use('/icons', express.static(path.join(__dirname, 'root/icons'), {
    maxAge: '1y'
}));
app.use(express.static(path.join(__dirname, 'root'), {
    setHeaders: (res, path, stat) => {
        res.setHeader('Cache-Control', 'public, max-age=0');
    }
}));

// START WEBSERVER
http.createServer(app).listen(config.webuiport);

app.get('/', (req, res) => {
    res.redirect('/Index.html')
});
log.debug("Web page requested");




// START A ZONE
function _startZone(zonename) {
    for (var i in zones) {
        if (zones[i].name.toLowerCase() == zonename.toLowerCase()) {
            connectedDevices[i] = airtunes.add(zones[i].host, {
                port: zones[i].port,
                volume: compositeVolume(zones[i].volume)
            });
            zones[i].enabled = true;
            resp = zones[i];
        }
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    return resp;
}
app.get('/startzone/:zonename', function (req, res) {
    var zonename = req.params.zonename;
    var resp = {
        error: "zone not found"
    };

    log.debug("Zone start requested for " + zonename);


    resp = _startZone(zonename);
    res.json(resp);
});

// STOP A ZONE
function _stopZone(zonename) {
    for (var i in zones) {
        if (zones[i].name.toLowerCase() == zonename.toLowerCase()) {
            zones[i].enabled = false;
            if (connectedDevices[i]) {
                connectedDevices[i].stop();
            }
            resp = zones[i];
        }
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    return resp;
}
app.get('/stopzone/:zonename', function (req, res) {
    var zonename = req.params.zonename;
    var resp = {
        error: "zone not found"
    };

    log.debug("Zone stop requested for " + zonename);

    resp = _stopZone(zonename);
    res.json(resp);
});

// SET VOLUME (with composite volume)
function _setVolume(zonename, volume) {
    for (var i in zones) {
        if (zones[i].name.toLowerCase() == zonename.toLowerCase()) {
            zones[i].volume = volume;
            if (connectedDevices[i]) {
                connectedDevices[i].setVolume(compositeVolume(volume));
            }
            resp = zones[i];
        }
    }
    config.zones = zones;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    return volume;
}
app.get('/setvol/:zonename/:volume', function (req, res) {
    var zonename = req.params.zonename;
    var volume = req.params.volume;

    log.debug("Volume change requested for " + zonename);

    var resp = {
        error: "zone not found"
    };
    resp = _setVolume(zonename, volume);
    res.json(resp);
});



// GET ZONES INFORMATION FOR WEB APP
app.get('/zones', function (req, res) {
    log.debug("Zone list requested");

    var zonesNotHidden = zones.filter(function (z) {
        return (!z.hidden);
    });
    res.json(zonesNotHidden);
});



// HIDE A ZONE
function _hideZone(zonename) {
    for (var i in zones) {
        if (zones[i].name.toLowerCase() == zonename.toLowerCase()) {
            zones[i].hidden = true;
            resp = zones[i];
        }
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    return resp;
}
app.get('/hidezone/:zonename', function (req, res) {
    var zonename = req.params.zonename;
    var resp = {
        error: "zone not found"
    };

    log.debug("Zone hide requested for " + zonename);

    resp = _hideZone(zonename);
    res.json(resp);
});



// SHOW A ZONE
function _showZone(zonename) {
    for (var i in zones) {
        if (zones[i].name.toLowerCase() == zonename.toLowerCase()) {
            zones[i].hidden = false;
            resp = zones[i];
        }
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    return resp;
}
app.get('/showzone/:zonename', function (req, res) {
    var zonename = req.params.zonename;
    var resp = {
        error: "zone not found"
    };

    log.debug("Zone show requested for " + zonename);

    resp = _showZone(zonename);
    res.json(resp);
});

app.get('/trackinfo', function (req, res) {
    log.debug("Trackinfo requested");
    res.json(trackinfo);
});


// ARTWORK FUNCTION
function getArtwork(artist, album, callback) {
    var url = `http://itunes.apple.com/search?term=${artist} ${album}`;

    http.get(url, function (res) {
        var body = '';

        res.on('data', function (chunk) {
            body += chunk;
        });

        res.on('end', function () {
            var albumInfo = JSON.parse(body);
            if (albumInfo.resultCount > 0) {
                callback(albumInfo.results[0].artworkUrl100.replace('100x100', '600x600'));
            } else {
                callback('/genericart.png');
            }
        });
    }).on('error', function (e) {
        callback('/genericart.png');
    });
}


// DISCOVERY FUNCTIONS FOR AIRPLAY DEVICES
function getIPAddress(service) {

    addresses = service.addresses;
    // Extract right IPv4 address
    var rx = /^(?!0)(?!.*\.$)((1?\d?\d|25[0-5]|2[0-4]\d)(\.|$)){4}$/;
    for (var a in addresses) {
        // Test if we can find an ipv4 address
        if (rx.test(addresses[a]) && addresses[a].lastIndexOf('169', 0) !== 0) {
            return addresses[a];
            break;
        }
    }
}

function validateDevice(service) {

    // Extract IP address, hostname and port from mdns descriptor
    service.ip = getIPAddress(service);
    //service.id = service.ip + ":" + service.port;
    service.name = service.name.split('@')[1];

    // Ignore self
    if (service.name == config.servername) return;

    // Check whether we know this zone already - if we do, do not add it again
    var zoneUnknown = true;
    var zoneChanged = false;
    for (var i in zones) {
        if (zones[i].name.toLowerCase() == service.name.toLowerCase()) {
            // Duplicate found which already existed in the config. Mind we match on the fqdn the host claims to have.
            if (service.ip != zones[i].host) {
                zones[i].host = service.ip;
                zoneChanged = true;
            }
            if (service.port != zones[i].port) {
                zones[i].port = service.port;
                zoneChanged = true;
            }
            zoneUnknown = false;
        }
    }

    // If it is a new zone, thank you very much, add it and write it to our config
    // TODO: I re-used the ./config.json used elsewhere in this application. Ideally, it should take the parameter passed in --config and not just 'require' the file but properly read it and parse it and write it back here
    if (zoneUnknown) {
        zones.push({
            "name": service.name,
            "host": service.ip,
            "port": service.port,
            "volume": 0,
            "enabled": false,
            "hidden": false
        });
        log.info('New zone added: ' + service.name);
    }
    if (zoneUnknown || zoneChanged) {
        config.zones = zones;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
        log.debug('Synced running config to config file');
    }

};

process.on('SIGTERM', function () {
    log.debug("Exiting...");
    log.debug("Writing config to " + configPath);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    process.exit(1);
});


// browse for all raop services
var browser = bonjour.find({
    type: 'raop'
});

browser.on('up', function (service) {
    log.debug("New device detected: " + JSON.stringify(service), null, 4);
    validateDevice(service);
});

browser.on('down', function (service) {
    // TODO
    log.debug("Device is down: " + JSON.stringify(service), null, 4);

});


// MQTT functions
    function mqttPub(topic, payload, options) {
        log.debug('mqtt >', topic, payload);
        mqtt.publish(topic, payload, options);
    }


// Assist functions

// speaker is a string, the speakername
function _isSpeakerKnown(speaker) {
        // Check whether this message is about GLOBAL or a specific speaker which we know about 
        for (var i in zones) {
            if (zones[i].name.toLowerCase() == speaker.toLowerCase() || speaker.toLowerCase() == "GLOBAL".toLowerCase()) {
                // This is a known speaker - continue parsing
		return true;
            }
        }

        return false;
}

// msgtype is a string: get, set or status
function _isStatusMessage(msgtype) {
        if (msgtype.toLowerCase() == "status") {
            return true;
        }
        return false;
}

// speaker is a string, the speakername
function _isGlobalVolumeMessage(speaker) {
        if (speaker.toLowerCase() == "GLOBAL".toLowerCase()) {
            // This request is about GLOBAL volume
            return true;
        }
return false;
}

function _isValidMessageType(msgtype) {
     if (['get', 'set', 'status'].indexOf(msgtype) >= 0)   {
            // The msgtype is good
            return true;
        }
     return false;
}

/*
function _ () {
}
*/

browser.start();
