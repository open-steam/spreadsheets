var express = require('express');
var sharejs = require('share').server;
var request = require('request');
var colorconverter = require("color-convert")();

var os = require('os');
var url = require('url');
var fs = require('fs');
var path = require('path');

var settings = require('./settings');
var unserialize = require('./unserialize');

//dictinary with opened docuemnts
var documentDict = {};
//list of external sessions
var externalSessions = {};

// Store the documents to sTeam every settings.SYNC_TO_STEAM_INTERVAL minutes
if (settings.AUTO_SYNC) {
    setInterval(syncToSteam, settings.SYNC_TO_STEAM_INTERVAL * 60000);
}
// Check for time outs every 5 seconds
setInterval(timeOut, 5000);


//added exception handler so the node doesn't terminate on an exception
process.on('uncaughtException', function(err) {
    console.log(err);
});

//save opened documents to steam before exiting
process.on('SIGINT', function () {
    console.log('Save documents before exiting...');
    syncToSteam(function () {
        process.exit();
    });
});

/**
* returns a function which creates a different color each time it is called
*/
function getColorGenerator() {
    var hsv = [90, 90, 90];
    var seed = 0;
    return function () {
            hsv[0] = (hsv[0]+60) % 360;

            seed++;

            if (seed % 6 === 0) {
                hsv[0] = (hsv[0]+30) % 360;
                hsv[1] = (hsv[1]+30) % 100;
                hsv[2] = (hsv[2]+20) % 100;
            }

            if (hsv[1] < 45) hsv[1] = 45;
            if (hsv[2] < 50) hsv[2] = 50;

            var rgb = colorconverter.hsv(hsv[0], hsv[1], hsv[2]).rgb();
            return 'rgb('+rgb[0]+','+rgb[1]+','+rgb[2]+')';
        };
}

/**
* reads the login name from the serialized php session
*
* @param {String} session_id id of the php session
* @param {Function} [callback] will be called when reading the username is done
*/
function getUserFromSession(session_id, callback) {
	console.log("getUserFromSession");
    //var filename = '/var/lib/php5/sess_'+session_id;
    var filename = path.join(settings.PHP_SESSION_DIR, '/sess_'+session_id);
    console.log('check existece session file '+filename);
    fs.exists(filename, function (exists) {
        if (exists) {
            console.log('Found session file');
            fs.readFile(filename, 'utf-8', function (error, data) {
                if (error) {
                    callback(error);
                }
                else {
                    console.log('session file opened. Trying to read...');
                    console.log('session file raw contents :'+data);
                    try {
                        var session = unserialize.unserialize_session(data);
                        console.log('session file contents: '+JSON.stringify(session));
                        console.log('username: '+session['LMS_USER']['*login']);
                        callback(null, session['LMS_USER']['*login']);
                    }
                    catch (exception){
                        callback('session could not be read: '+exception);
                    }
                }
            });
        }
        else callback('session file '+filename+' does not exist');
    });
}

/**
* reads the login name from an external session
*
* @param {String} session_id id of the session in the other system
* @param {Function} [callback] will be called when reading the username is done
*/
function getUserFromExternalSession(session_id, callback) {
    console.log("getUserFromExternalSession");
    if (externalSessions[session_id] != undefined) {
        console.log("checking login credentials for session "+session_id);
        var steamURL = "http://" + externalSessions[session_id].username+ ":" + externalSessions[session_id].password + "@" + settings.STEAM_SERVER_HOST + "Rest/";
        request({url: steamURL, method: "POST"},
                function (error, response, body) {
                    if (response.statusCode == 401) {
                        callback('external session not valid');
                    } else {
                        callback(null, externalSessions[session_id].username);
                    }
                }
        );
    } else {
        callback('external session '+session_id+' does not exist');
    }
}

/**
* makes a request to koaLA to get the permissions for the user
*
* @param {String} docName name of the document
* @param {String} userName name of the user
* @param {Function} callback will be called when check is done
*/
function getUserPermission(docName, userName, callback) {
	console.log("getUserPermission");
    var steamURL = "http://" + settings.STEAM_USER + ":" + settings.STEAM_PASSWORD + "@" + settings.STEAM_SERVER_HOST + "spreadsheets/GetUserPermissions/" + docName + "/"+ userName;

    request({url: steamURL},
            function (error, response, body) {
                if (error) {
                    callback(error);
                }
                else {
                    callback(null, body);
                }
            }
    );
}

/**
* remove a document
*
* @param {String} docName name of the document
* @param {Function} [callback] will be called when removal is done
*/
function removeDocument(docName, callback) {
    if (documentDict[docName].state === "open") {
        documentDict[docName].state = "closing";
        server.model.getSnapshot(docName, function(error, data) {
            if (error && callback) {
                    callback(error);
            }
            else {
                server.model.delete(docName, function(error, data) {
                    if (error && callback) {
                        callback(error);
                    }
                    else {
                        var steamURL = "http://" + settings.STEAM_USER + ":" + settings.STEAM_PASSWORD + "@" + settings.STEAM_SERVER_HOST + "spreadsheets/RemoveEditAttribute/" + docName;

                        request({url: steamURL},
                                function (error, response, body) {
                                    if (error) {
                                        console.log(error);
                                    }
                                    else {
                                        console.log(body);
                                        var callbackQueue = [];
                                        if (documentDict[docName].closedCallback) {
                                            callbackQueue.push(documentDict[docName].closedCallback);
                                        }
                                        if(callback) {
                                             callbackQueue.push(callback);
                                        }
                                        delete documentDict[docName];
                                        console.log('deleted document ' + docName);
                                        for (var i = callbackQueue.length - 1; i >= 0; i--) {
                                            callbackQueue[i]();
                                        }
                                    }
                                }
                        );
                    }
                });
            }
        });
    }
}

/**
* add a new user to the lists in the document and on the server
*
* @param {String} docName name of the document
* @param {Object} agent the ShareJS use agent of the new user
* @param {Function} [callback] will be called when the new user is added
*/
function addUser(docName, agent, callback) {
    var userName = agent.name;
    var userObject;
    var userColor;

    if (!callback) {
        callback = function () {};
    }

    //add the user to the list in the documentDict
    documentDict[docName].users[userName] = {
                                                agent: agent,
                                                timeout: settings.PING_TIMEOUT * 60000
                                            };

    userColor = documentDict[docName].getNewColor();

    //add the user to the user list in the document
    server.model.getSnapshot(docName, function(error, data) {
        if (error) {
            callback(error);
        }
        else {
            userObject = data.snapshot.users[userName];
            if (!userObject) {
                userObject = {"name":userName, "color": userColor, "selection":""};
                server.model.applyOp(docName, {op:[{p:['users', userName], oi:userObject}], v:data.v}, function(error) {
                    if (error) {
                        callback(error);
                    }
                    else {
                        callback(null);
                    }
                });
            }
        }
    });
}

/**
* remove the user from the lists in the document and on the server and closes the document if all users are disconnected
*
* @param {String} docName name of the document
* @param {String} userName user who will be disconnected
*/
function removeUser(docName, userName) {
    //remove the user from the user list in the document
    server.model.getSnapshot(docName, function(error, data) {
        if (error) {
            console.log(error);
        }
        else {
            var userObject = data.snapshot.users[userName];
            if (userObject) {
                server.model.applyOp(docName, {op:[{p:['users', userName], od:userObject}], v:data.v}, function(error) {
                    if (error) {
                        console.log(error);
                    }
                });
            }
            //disconnect the user and remove him from the list in the documentDict
            delete documentDict[docName].users[userName];

            if (Object.keys(documentDict[docName].users).length === 0) {
                //no users editing the document - save it to sTeam and remove it
                saveDocToSteam(docName, function(error, response, body) {
                    if(!error && body == "saved document "+docName) {
                        //saving successfull - remove the document
                        //setTimeout(removeDocument(docName), 3000);
                        removeDocument(docName);
                    }
                });
            }
        }
    });
}

/**
 * decrease the timers for all users and check if they are 0
 *
 */
function timeOut() {
    for(var docName in documentDict) {
        for(var userName in documentDict[docName].users) {
            documentDict[docName].users[userName].timeout -= 5000;
            if (documentDict[docName].users[userName].timeout <= 0) {
                removeUser(docName, userName);
                console.log('user ' + userName + ' disconnected (timeout)');
            }
        }
    }
}

/**
 * Saves the given document to the sTeam/koaLA server
 *
 * @param {String} docName name of the document
 * @param {Function} [callback] will be called whith the response of the sTeam/koaLA server
 */
function saveDocToSteam(docName, callback) {
    server.model.getSnapshot(docName, function(error, data) {
        if (error || data.snapshot === null) {
            error = error || "document is null";
            console.log("Storing document " + docName + " to Steam was not possible, could not get snapshot: "+error);
        }
        else {
            // dont save user data to sTeam
            var doc_data = {"sheets": data.snapshot.sheets,
                            "users" : {}
                        };
            // put authentication data into the URL
            var steamURL = "http://" + settings.STEAM_USER + ":" + settings.STEAM_PASSWORD + "@" + settings.STEAM_SERVER_HOST + "spreadsheets/CheckAuth/" + docName;

            request({url: steamURL,
                     method: "PUT",
                     json: doc_data
                    },
                    function (error, response, body) {
                        if (error) {
                            console.log(error);
                        }
                        console.log(body);
                        if(callback) {
                            callback(error, response, body);
                        }
                    }
            );
        }
    });
}

/**
 * Iterates through all opened Documents and stores them in the sTeam/koaLA server
 *
 */
function syncToSteam(callback) {
    //counter to register when all documents are saved
    var counter = Object.keys(documentDict).length;
    for(var docName in documentDict)
    {
        saveDocToSteam(docName , function() {
            counter--;
            if (counter === 0 && callback) {
                callback();
            }
        });
    }

    if (counter === 0 && callback) {
        callback();
    }
}

var server = express();
//server.use(express.logger());
server.use(express.bodyParser());
server.use(server.router);

    // Action for setting the document contents
    server.post('/doc/set/:docName', function(req, res, next) {
        var docName = req.params.docName;
        var content = req.body;

        //only the sTeam/koaLA server is authorized to use this function
        if (req.connection.remoteAddress !== settings.STEAM_SERVER_IP) {
            res.statusCode = 401;
            res.end('Unauthorized');
        }
        else {
            server.model.getSnapshot(docName, function(error, data) {
                if (error == 'Document does not exist') {
                    //create the document if it doesn't exist
                        server.model.create(docName, 'json', function() {
                            server.model.applyOp(docName, {op:[{oi:content, p:[]}], v:0}, function() {
                            });
                            documentDict[docName] = {users: {}, state: "open", getNewColor: getColorGenerator()};
                            res.end('Document created and set');
                        });
                    }
                else {
                    server.model.applyOp(docName, {op:[{oi:content, p:[]}], v:0}, function() {
                    });
                    res.end('Document set');
                }
            });
        }
    });

    // pushing external session
    server.post('/pushSession', function(req, res, next) {
        if (req.connection.remoteAddress !== settings.STEAM_SERVER_IP) {
            res.statusCode = 401;
            res.end('Unauthorized');
        }
        else {
            if (req.body.id != undefined) {
                externalSessions[req.body.id] = {
                            "id": req.body.id,
                            "username": req.body.username,
                            "password": req.body.password
                };
                console.log('session pushed '+req.body.id);
                res.end('External Session saved');
            } else {
                console.log('error pushing external session');
                res.end('External Session error');
            }
        }
    });

    // Action for getting the document contents
    server.get('/doc/get/:docName', function(req, res, next) {
        var docName = req.params.docName;

        //only the sTeam/koaLA server is authorized to use this function
        if (req.connection.remoteAddress !== settings.STEAM_SERVER_IP) {
            res.statusCode = 401;
            res.end('Unauthorized');
        }
        else {
            server.model.getSnapshot(docName, function(error, data) {
                if (error) {
                    res.statusCode = 500;
                    res.end(error);
                }
                else {
                    res.end(JSON.stringify(data.snapshot));
                }
            });
        }
    });

    // Action to test if the document exists
    server.get('/doc/exists/:docName', function(req, res, next) {
        var docName = req.params.docName;

        //only the sTeam/koaLA server is authorized to use this function
        if (req.connection.remoteAddress !== settings.STEAM_SERVER_IP) {
            console.log('Unauthorized: IP is '+req.connection.remoteAddress+' but should be '+settings.STEAM_SERVER_IP);
            res.statusCode = 401;
            res.end('Unauthorized');
        }
        else {
            if(documentDict[docName]) {
                if(documentDict[docName].state === "closing") {
                    documentDict[docName].closedCallback = function () {
                        console.log('DBG: Doc '+docName+' does not exist');
                        res.end('Document does not exist');
                    };
                    console.log('DBG: waiting for closing Doc '+docName);
                }
                else {
                    console.log('DBG: Doc '+docName+' exists');
                    documentDict[docName].state = "opening";
                    res.end('Document exists');
                }
            }
            else {
                console.log('DBG: Doc '+docName+' does not exist');
                res.end('Document does not exist');
            }
        }
    });

    // Action to delete a document
    server.get('/doc/delete/:docName', function(req, res, next) {
        var docName = req.params.docName;

        //only the sTeam/koaLA server is authorized to use this function
        if (req.connection.remoteAddress !== settings.STEAM_SERVER_IP) {
            res.statusCode = 401;
            res.end('Unauthorized');
        }
        else {
            removeDocument(docName, function(error) {
                if (error) {
                    res.statusCode = 500;
                    res.end(error);
                }
                else {
                    res.end('Document deleted');
                }
            });
        }
    });

var options = {
    browserChannel: {cors:settings.RT_SERVER_HOST},
    rest: null,
    db: {type: 'none'},
    /**
     * Gets called everytime before a user tries to connect or submit an operation
     * (see https://github.com/josephg/ShareJS/wiki/User-access-control)
     *
     * @param {Object} agent Stores an ID and the name of the client
     * @param {Object} action Stores the type of the action. Must be either accepted or rejected.
     */
    auth: function (agent, action) {
            if (action.name == 'connect') {
                agent.name = 'Unknown';

                console.log('client trying to connect with session id '+agent.authentication);
                getUserFromExternalSession(agent.authentication, function(error, username) {
                    if(username) {
                        console.log('user '+username+' connected');
                        agent.name = username;
                        action.accept();
                    }
                    else {
                        console.log('User could not be authenticated: '+error);
                        action.reject();
                    }
                });
            }
            else if (action.name == 'open') {
                documentDict[action.docName].state = "open";
                getUserPermission(action.docName, agent.name, function(error, permissions) {
                    if (error) {
                        console.log(error);
                        action.reject();
                    }
                    else if (permissions !== 0) {
                        addUser(action.docName, agent, function(error) {
                            if (error) {
                                console.log(error);
                            }
                            documentDict[action.docName].users[agent.name].permissions = permissions;
                        });
                        action.accept();
                    }
                    else {
                        action.reject();
                    }
                });
            }
            else if (action.name == 'create') {
                action.reject();
            }
            else if (action.name == 'get snapshot') {
                action.accept();
            }
            else if (action.name == 'submit op') {
                //dont accept ops from users who dont have write permission
                if (documentDict[action.docName].users[agent.name].permissions !== "w"){
                    action.reject();
                }
                else if(action.op[0].p[0] == 'users') {
                    if (action.op[0].p[1] !== agent.name ) {
                        //reject modifications from other users on user object
                        console.log('forbidden to modify user data! (' + agent.name + '!=' + action.op[0].p[1]);
                        action.reject();
                    }
                    else {
                        if (action.op[0].p.length == 2 && action.op[0].od !== undefined) {
                            //user removed - disconnect him
                            removeUser(action.docName, agent.name);
                            console.log('user ' + agent.name + 'disconnected');
                        }
                        action.accept();
                    }
                }
                else {
                    action.accept();
                }

                documentDict[action.docName].users[agent.name].timeout = settings.PING_TIMEOUT * 1000;
            }
            else {
                action.reject();
            }
            console.log(agent.name+': '+action.name);
        }
    };

// Attach the sharejs REST and Socket.io interfaces to the server
sharejs.attach(server, options);
server.listen(settings.RT_SERVER_PORT);
console.log('Server running at '+ os.hostname() +':'+settings.RT_SERVER_PORT);