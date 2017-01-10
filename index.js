#!/usr/bin/env node

var config;
var zones;
var argv = require('minimist')(process.argv.slice(2));
if (!argv.c && !argv.config) {
    console.log('usage: node-airplayhub [options]\n  options:\n    -c, --config     Path to config file')
    process.exit();
} else {
    if (argv.c) {
        config = require(argv.c);
    } else if (argv.config) {
        config = require(argv.config);
    }
    zones = config.zones;
}

var express = require('express');
var logger = require('morgan');
var path = require('path');
var app = express();
var http = require('http');
var airtunes = require('airtunes')
var airtunesserver = require('nodetunes');
var bonjour = require('bonjour')();
var fs = require('fs')
var connectedDevices = [];
var trackinfo = {};
var idleTimer;




//MQTT
var mqttconfig = {
	prefix : 'airplay/command',
	resultprefix : 'airplay/status',
	url : 'mqtt://URL:PORT'
};
var mqtt = require('mqtt').connect(mqttconfig.url, {
	username : 'USER',
	password : 'PASSWORD',
	will : {
		topic : mqttconfig.prefix + '/daemonconnected',
		payload : '0'
	}
});
mqtt.publish(mqttconfig.resultprefix + '/daemonconnected', '1'); 
var topic = mqttconfig.prefix + '/#'; 
mqtt.subscribe(topic);


// MQTT LISTENER
mqtt.on('message',function(topic, message) {
					var parts = topic.split('/');
					if (parts[1] !== 'command') {
						return;
					}
					var keyword = parts[2];
					var speaker = parts[3];
					console.log("Message incoming on " + keyword + " for speaker " + speaker);

					switch (keyword) {
					case 'startzone':
							console.log("START ZONE "+speaker );
							break;
					case 'stopzone':
						console.log("STOP ZONE "+speaker );
						break;
					case 'setvolume':
						if (isNaN(message)) {
							try {
								var obj = JSON.parse(message);
								setVolume(speaker, obj.val);
							} catch (e) {

							}
						} else {
							setVolume(speaker, parseInt(message, 10));
						}
						break;
					case 'getvolume':
						mqtt.publish(
								config.resultprefix + '/volume/' + speaker,
								speakers.getSpeakerByName(speaker).volume
										.toString(), {});
						break;
					default:
						console.log("command not understood");
						break;
					}
				});







var server = new airtunesserver({ serverName: config.servername, verbose: config.debug });

server.on('clientConnected', function (stream) {
    clearTimeout(idleTimer);
    stream.pipe(airtunes);
    mqtt.publish(mqttconfig.resultprefix + '/' + '/clientconnected', '1', {});
    for (var i in zones) {
        if (zones[i].enabled) {
            connectedDevices[i] = airtunes.add(zones[i].host, { port: zones[i].port, volume: zones[i].volume });

        }
    }
});

server.on('clientDisconnected', (data) => {
    clearTimeout(idleTimer);
    mqtt.publish(mqttconfig.resultprefix + '/' + '/clientconnected', '0', {});
    if (config.idletimout > 0) {
        idleTimer = setTimeout(() => {
            airtunes.stopAll(() => {
                for (var i in zones) {
                    zones[i].enabled = false;
                }
            });
        }, config.idletimout * 1000);
    }
});

server.on('metadataChange', (data) => {
    trackinfo = data;
    getArtwork(trackinfo.asar, trackinfo.asal, (url) => {
        if (url) {
            trackinfo.albumart = url;
        } else {
            trackinfo.albumart = '/genericart.png';
        }
   if (trackinfo.minm && trackinfo.asar) {
	   mqtt.publish(mqttconfig.resultprefix + '/' + 'metadata', trackinfo.asar+" - "+trackinfo.minm, {});
	   console.log(trackinfo);
   }
   });
});


server.on('volumeChange', (data) => {
    mqtt.publish(mqttconfig.resultprefix + '/globalvolume', data.toString(), {});
    clearTimeout(idleTimer);
});

server.start();


// No need to monitor buffer, this coincides with the clientconnected event and airtunes nicely waits for new nodetunes input (and this stays connected so airtunes remains in buffering mode,  never stopped)
//airtunes.on('buffer', function(status) {
//	console.log('buffer', status);
//});


if (config.debug) { app.use(logger('dev')) };

app.use('/icons', express.static(path.join(__dirname, 'root/icons'), { maxAge: '1y' }));
app.use(express.static(path.join(__dirname, 'root'), { setHeaders: (res, path, stat)=> {
    res.setHeader('Cache-Control', 'public, max-age=0');
}}));

http.createServer(app).listen(config.webuiport);

app.get('/', (req, res) => { res.redirect('/Index.html') });

app.get('/startzone/:zonename', function (req, res) {
    var zonename = req.params.zonename;
    var resp = { error: "zone not found" };
    for (var i in zones) {
        if (zones[i].name.toLowerCase() == zonename.toLowerCase()) {
            connectedDevices[i] = airtunes.add(zones[i].host, { port: zones[i].port, volume: zones[i].volume });
	    connectedDevices[i].on('status', function(status) {
		console.log(zones[i].host + " STATUS " + status);
 	    });
	    connectedDevices[i].on('error', function(error) {
		console.log(zones[i].host + " ERROR " + error);
 	    });
            zones[i].enabled = true;
            resp = zones[i];
        }
    }
    res.json(resp);
});

app.get('/stopzone/:zonename', function (req, res) {
    var zonename = req.params.zonename;
    var resp = { error: "zone not found" };
    for (var i in zones) {
        if (zones[i].name.toLowerCase() == zonename.toLowerCase()) {
            zones[i].enabled = false;
            if (connectedDevices[i]) {
                connectedDevices[i].stop();
            }
            resp = zones[i];
        }
    }
    res.json(resp);
});

app.get('/setvol/:zonename/:volume', function (req, res) {
    var zonename = req.params.zonename;
    var volume = req.params.volume;
    var resp = { error: "zone not found" };
    for (var i in zones) {
        if (zones[i].name.toLowerCase() == zonename.toLowerCase()) {
            zones[i].volume = volume;
            if (connectedDevices[i]) {
                connectedDevices[i].setVolume(volume);
 	        mqtt.publish(mqttconfig.resultprefix + '/'+ zones[i].name + '/volume', volume, {});
 
            }
            resp = zones[i];
        }
    }
    config.zones = zones;
    fs.writeFileSync('/etc/airplayconfig.json', JSON.stringify(config, null, 4));
    res.json(resp);
});

app.get('/zones', function (req, res) {
    res.json(zones);
});

app.get('/trackinfo', function (req, res) {
    res.json(trackinfo);
});

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


function getIPAddress(service) {

	addresses = service.addresses;
	// Extract right IPv4 address
	var rx = /^(?!0)(?!.*\.$)((1?\d?\d|25[0-5]|2[0-4]\d)(\.|$)){4}$/;
	for ( var a in addresses) {
		// Test if we can find an ipv4 address
		if (rx.test(addresses[a]) && addresses[a].lastIndexOf('169', 0) !== 0) {
			return addresses[a];
			break;
		}
	}
}

function validateDevice(service) {

    console.log("INCOMING SERVICE "+service.host);
 
    service.ip = getIPAddress(service);
    service.id = service.ip + ":" + service.port;

	
    var zoneUnknown = true;
    for (var i in zones) {
        if (zones[i].name.toLowerCase() == service.host.toLowerCase()) {
            console.log("KNOWN "+service.host);
	     // Duplicate found which already existed in the config. Mind we match on the fqdn the host claims to have.
	    zoneUnknown = false;
	}
    }

    if (zoneUnknown) {
        console.log("ADDING  "+service.host);
	zones.push({"name": service.host , "host": service.ip,"port": service.port, "volume":0, "enabled":false});	    
	config.zones = zones;
        fs.writeFileSync('/etc/airplayconfig.json', JSON.stringify(config, null, 4));
    }

};


// browse for all raop services
var browser = bonjour.find({
	type : 'raop'
});

browser.on('up', function(service) {
	validateDevice(service);
});

browser.on('down', function(service) {
	// TODO
});

browser.start();
