exports.RT_SERVER_HOST = "http://localhost"; //the ip/hostname under which the client will access the RT-Server
exports.RT_SERVER_PORT = 8000;
exports.STEAM_SERVER_HOST = "localhost/"; //the path which the RT-Server will use to access steam/koala
exports.STEAM_SERVER_IP = "localhost"; //used to authenticate the requests from the steam/koala server
exports.STEAM_USER = "root";
exports.STEAM_PASSWORD = "*****";
exports.SYNC_TO_STEAM_INTERVAL = 2; //interval (in minutes)
exports.AUTO_SYNC = true    // set to false to turn off storing documents regularly
exports.PING_TIMEOUT = 20; //timeout (in seconds) after which clients will be disconnected if they dont send the "alive"-ping