

'use strict';

var mqtt = require('mqtt');
var tinycolor = require('tinycolor2');

var conf = require('../configuration');
var utils = require('../utils');
var log = require('../logger');
var Eventer = require('../eventer');

var PatternsService = require('./patternsService');

var MqttService = {
	config: {},
	rules: [],
    timer: null,
    // FIXME: "reloadConfig()" should really be "restartService" or something
    reloadConfig: function() {
        log.msg("MqttService.reloadConfig");
        this.stop();
        this.start();
    },
    start: function() {
        var self = this;

        self.config = conf.readSettings('eventServices:mqttService');
        if( !this.config ) {
            log.msg("MqttService.reloadConfig: NO CONFIG");
            self.config = {
                type: 'mqtt',
                service: 'mqttService',
                enabled: true,
                reconnectPeriod: 10000,
            };
            conf.saveSettings('eventServices:mqttService', self.config);
        }
        // var allrules = conf.readSettings('eventRules') || [];
        var allrules = conf.readSettings('eventRules') || [];
        self.rules = allrules.filter( function(r){return r.type === 'mqtt';} );

        self.rules.map( function(rule) {
            log.msg("MqttService.start: rule:", rule);
            if( !rule.enabled ) { return; }
            var pass = '';
            try {
                if( rule.passwordHash !== '' ) {  // allow password-less login
                  pass = utils.decrypt( rule.passwordHash );
                }
            } catch(err) {
                log.msg('MqttService: ERROR bad password for username', rule.username);
            }
            // FIXME: impelement sanity checks
            // if( !rule.url ) { }
            // if !rule.topic ) { }
            var mqtt_config = {
              reconnectPeriod: self.config.reconnectPeriod
            };
            mqtt_config.username = rule.username;
            mqtt_config.password = pass;
            log.msg("MqttService.start: mqtt_config:", mqtt_config);
            var client = mqtt.connect( rule.url, mqtt_config );
            self.errorLogged = false;  // reset
            client.on('connect', function () {
                log.msg("MqttService.connected");
                Eventer.addStatus( {type:'info', source:rule.type, id:rule.name, text:"connected"} );
                client.subscribe( rule.topic );
            });
            client.on('disconnect', function() {
              log.msg("MqttService.disconnect");
            });
            client.on('close', function() {
              log.msg("MqttService.close");
              if( !self.errorLogged ) {
                Eventer.addStatus( {type:'info', source:rule.type, id:rule.name, text:"connection closed, bad auth?"} );
              }
            });
            client.on('end', function() {
              log.msg("MqttService.end");
            });
            client.on('error', function(error) {
              console.log("bAKKBKBKB",error);
              log.msg('MqttService.error: error json',JSON.stringify(error), error.toString());
              Eventer.addStatus( {type:'info', source:rule.type, id:rule.name, text:error.toString() } );
              self.errorLogged = true;
            });
            client.on('message', function (topic, message) {
              log.msg("MqttService: message: topic:", topic, "message:",message.toString());
              // parse() will fill out Eventer.addStatus() for us
              self.parse(rule, message.toString());  // message is Buffer, thus .toString()
              // Eventer.addStatus( {type:'trigger', source:rule.type, id:rule.name, text:message.toString()} );
              //Eventer.addStatus( {type:'info', source:rule.type, id:rule.name, text:message.toString()} );
            });
            rule.client = client;
        });

    },
    stop: function() {
      log.msg("MqttService.stop");
      this.rules.forEach( function(rule) {
          if( rule.client ) {
              rule.client.end();
              rule.client = null;
          }
      });
    },

    playPattern: function(pattid,ruleid,blink1id) {
        if( PatternsService.playPatternFrom( ruleid, pattid, blink1id ) ) {
            // this.lastPatterns[ruleid] = pattid;
            return pattid;
        }
        return false;
    },

    /**
     * (FIXME: Copied from scriptService.parse(), pull these out into single common one)
     * Parse the output from a MQTT response.
     * Plays patterns if match.
     * Sends log messages with source & id of rule.
     * Checks for the following content:
     * if 'actionType == 'parse-json', treat content as JSON,
     *   and look for 'pattern' or 'color' keys
     *   'pattern' can be meta-pattern like: '~off' and '~blink'
     * if 'actionType == 'parse-pattern', attempt to find a pattern
     *   with the "pattern:<patternname>" format, and play it.
     *   Can also use meta-patterns here.
     * if 'actionType == 'parse-color', look in text for RGB hex color string
     *
     * @param  {Rule} rule eventRules rule for this content
     * @param  {String} str  the content to be parsed, potentially multiple lines
     * @return {[type]}      [description]
     */
    parse: function(rule, str) {
        if( typeof str != "string" ) {
            str = (str) ? str.toString() : ''; // convert to string
        }
        str = str.substring(0,this.config.maxStringLength);
        var self = this;
        //var patternre = /pattern:\s*(#*\w+)/; // orig
        //var patternre = /pattern:\s*(\"([^"])*\"|#?\w+)/; // suggested by @slakichi in issue #101
        var patternre = /pattern:\s*("*)(.+)\1/; // match everything either quoted or not
        var colorre = /(#[0-9a-f]{6}|#[0-9a-f]{3}|color:\s*(.+?)\s)/i; // regex to match hex color codes or 'color:' names
        var matches;

        // if( self.lastEvents[rule.name] === str && rule.actOnNew ) {
        //     Eventer.addStatus( {type:'info', source:rule.type, id:rule.name, text:'not modified'});
        //     return;
        // }
        // self.lastEvents[rule.name] = str;
        // Eventer.addStatus( { type:'trigger', text:data.substring(0,40), source:rule.type, id:rule.name} );

        var actionType = rule.actionType;
        if( actionType === 'parse-json' ) {
            var json = null;
            try {
                json = JSON.parse(str);
                if( json.pattern ) {
                    // returns true on found pattern // FIXME: go back to using 'findPattern'
                    if( this.playPattern( json.pattern, rule.name, rule.blink1Id ) ) {
                        Eventer.addStatus( {type:'trigger', source:rule.type, id:rule.name, text:json.pattern});
                    }
                    else {
                        Eventer.addStatus( {type:'error', source:rule.type, id:rule.name, text:'no pattern '+json.pattern});
                    }
                }
                else if( json.color ) {
                    var c = tinycolor(json.color);
                    if( c.isValid() ) {
                        Eventer.addStatus( {type:'trigger', source:rule.type, id:rule.name, text:json.color});
                        this.playPattern( c.toHexString(), rule.name, rule.blink1Id );
                    } else {
                        Eventer.addStatus( {type:'error', source:rule.type, id:rule.name, text:'invalid color '+json.color});
                    }
                }
                else {

                }
            } catch(error) {
                log.msg("error:", error)
                Eventer.addStatus( {type:'error', source:rule.type, id:rule.name, text:error.message});
            }
        }
        else if( actionType === 'parse-pattern' ) {
            matches = patternre.exec( str );
            if( matches ) {
                var patt_name = matches[2]; // it's always the 2nd match, either quoted or not

                if( this.playPattern( patt_name, rule.name, rule.blink1Id ) ) {
                    Eventer.addStatus( {type:'trigger', source:rule.type, id:rule.name, text:patt_name});
                }
                else {
                    Eventer.addStatus( {type:'error', source:rule.type, id:rule.name, text:'no pattern '+str});
                }
            }
            else {
                Eventer.addStatus( {type:'error', source:rule.type, id:rule.name, text:'no pattern '+str});
            }
        }
        else { // parse-color
            matches = colorre.exec(str);
            if( matches && matches) {
                var colormatch = matches[2];
                if( !colormatch ) { colormatch = matches[1]; }

                var color = tinycolor( colormatch );
                if( color.isValid() ) {
                    Eventer.addStatus( {type:'trigger', source:rule.type, id:rule.name, text:colormatch});
                    this.playPattern( color.toHexString(), rule.name, rule.blink1Id );
                }
                else {
                    Eventer.addStatus( {type:'error', source:rule.type, id:rule.name, text:'invalid color '+colormatch});
                }
            }
            else {
                Eventer.addStatus( {type:'error', source:rule.type, id:rule.name, text:'no color found in:'+str});
            }
        }
    }

};

module.exports = MqttService;
