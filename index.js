

var amqp = require('amqp-coffee');
var uuid = require('node-uuid').v4;
var os   = require('os');
var debug= require('debug')('amqp-rpc');
var queueNo = 0;

function rpc(opt)   {

    if(!opt) opt = {};
    this.opt = opt;
    this.__conn             = opt.connection ? opt.connection : null;
    this.__url              = opt.url ? opt.url: 'amqp://guest:guest@localhost:5672';
    this.__exchange         = opt.exchangeInstance ? opt.exchangeInstance : null;
    this.__exchange_name    = opt.exchange ? opt.exchange : 'rpc_exchange';
    this.__exchange_options = opt.exchange_options ? opt.exchange_options : {exclusive: false, autoDelete: true };
    this.__conn_options     = opt.conn_options || {};

    this.__results_queue = null;
    this.__results_queue_name = null;
    this.__results_cb = {};
    this.__make_results_cb = [];

    this.__cmds = {};

    this.__connCbs = [];
    this.__exchangeCbs = [];
}

/**
 * generate unique name for new queue
 * @returns {string}
 */

rpc.prototype.generateQueueName = function(type)    {
    return /*'njsListener:' +*/ os.hostname() + ':pid' + process.pid + ':' + type;
}


rpc.prototype._connect = function(cb)  {

    if(!cb) {
        cb = function(){};
    }

    if(this.__conn) {
        if(this.__connCbs.length > 0)    {
                this.__connCbs.push(cb);

            return true;
        }
        return cb(this.__conn);
    } else {
        this.__conn = this.opt.connection ? this.opt.connection : null;
    }

    var $this = this;

    this.__connCbs.push(cb);
    var options = this.__conn_options;
    if(!options.url && !options.host) options.url = this.__url;
    debug("createConnection options=", options || {});
    this.__conn = new amqp(
      options
    );

    this.__conn.on('ready', function() {
      debug("connected to " + $this.__conn.serverProperties.product);
      var cbs = $this.__connCbs;
      $this.__connCbs = [];

      for(var i=0; i< cbs.length; i++)    {
          cbs[i]($this.__conn);
      }
    });
}
/**
 * disconnect from MQ broker
 */

rpc.prototype.disconnect = function()   {
    debug("disconnect()");
    if(!this.__conn) return;
    this.__conn.close();
    this.__conn = null;
}

rpc.prototype._makeExchange = function(cb) {

    if(!cb) {
        cb = function(){};
    }

    if(this.__exchange) {

        if(this.__exchangeCbs.length > 0)    {

            this.__exchangeCbs.push(cb);

            return true;
        }

        return cb(this.__exchange);
    }

    var $this = this;

    this.__exchangeCbs.push(cb);
  /*
   * Added option autoDelete=false.
   * Otherwise we had an error in library node-amqp version > 0.1.7.
   * Text of such error: "PRECONDITION_FAILED - cannot redeclare exchange '<exchange name>' in vhost '/' with different type, durable, internal or autodelete value"
   */
    this.__exchange = this.__conn.exchange({exchange: this.__exchange_name, autoDelete: false }).declare(function(err, exchange){
		debug('Exchange ' + $this.__exchange_name + ' is open');
        var cbs = $this.__exchangeCbs;
        $this.__exchangeCbs = [];

        for(var i=0; i< cbs.length; i++)    {
            cbs[i]($this.__exchange);
        }
	});

}

rpc.prototype._makeResultsQueue = function(cb) {

    if(!cb) {
        cb = function(){};
    }

    if(this.__results_queue) {
        if(this.__make_results_cb.length > 0)   {

            this.__make_results_cb.push(cb);
            return true;
        }
        return cb(this.__results_queue);
    }

    var $this = this;

    this.__results_queue_name = this.generateQueueName('callback');
    this.__make_results_cb.push(cb);

	$this._makeExchange(function()   {
		$this.__exchange_options.queue = $this.__results_queue_name;
		$this.__conn.queue($this.__exchange_options, function(error, q) {
			$this.__results_queue = q.declare(function(err, res){
				debug('Callback queue ' + q.queueOptions.queue + ' is open');
				$this.__conn.consume(q.queueOptions.queue, {},function(){$this.__onResult.apply($this, arguments);});
				q.bind($this.__exchange_name, $this.__results_queue_name, $this.__results_queue_name, function(err, res){
					debug('Bind queue ' + q.queueOptions.queue + ' to exchange ' + $this.__exchange_name);
					var cbs = $this.__make_results_cb;
					$this.__make_results_cb = [];

					for(var i=0; i<cbs.length; i++){
					   	cbs[i](q);
					}
				});
			});
		});
	});
}

rpc.prototype.__onResult = function(packet)   {
    debug("__onResult()");
	if(! this.__results_cb[ packet.properties.correlationId ]) return;

    var cb = this.__results_cb[ packet.properties.correlationId ];

    var args = [];
    if(Array.isArray(packet.data) ) {

      for(var i=0; i< packet.data.length; i++)   {
          args.push(packet.data[i]);
      }
    }
    else args.push(packet.data);

    cb.cb.apply(cb.context, args);

    if(cb.autoDeleteCallback !== false)
        delete this.__results_cb[ packet.properties.correlationId ];
}

/**
 * call a remote command
 * @param {string} cmd   command name
 * @param {Buffer|Object|String}params    parameters of command
 * @param {function} cb        callback
 * @param {object} context   context of callback
 * @param {object} options   advanced options of amqp
 */

rpc.prototype.call = function(cmd, params, cb, context, options) {
    debug('call()', cmd);
    var $this   = this;
    if(!options) options = {};
    options.contentType = 'application/json';
    var corr_id = options.correlationId || uuid();

    this._connect(function() {
        if(cb)  {
            $this._makeExchange(function(){
                $this._makeResultsQueue(function()   {
                    $this.__results_cb[ corr_id ] = {
                        cb: cb,
                        context: context,
                        autoDeleteCallback: !!options.autoDeleteCallback
                    };


                    options.mandatory = true;
                    options.replyTo   = $this.__results_queue_name;
                    options.correlationId = corr_id;
					//options.domain    = "localhost";
                    $this.__conn.publish(
						$this.__exchange_name,
                        cmd,
                        new Buffer(JSON.stringify(params, 'utf8')),
                        options,
                        function(err)   {
                            if(err) {
                                delete $this.__results_cb[ corr_id ];

                                cb(err);
                            }
                        }
                    );
                });
            });

        }
        else {

            $this._makeExchange(function(){

                $this.__conn.publish(
					$this.__exchange_name,
                    cmd,
                    JSON.stringify(params),
                    options
                );
            });
        }
    });

    return corr_id;
}

/**
 * add new command handler
 * @param {string} cmd                command name or match string
 * @param {function} cb               handler
 * @param {object} context            context for handler
 * @param {object} options            advanced options
 * @param {string} options.queueName  name of queue. Default equal to "cmd" parameter
 * @param {boolean} options.durable   If true, the queue will be marked as durable.
 *                                    Durable queues remain active when a server restarts.
 *                                    Non-durable queues (transient queues) are purged if/when a server restarts.
 *                                    Note that durable queues do not necessarily hold persistent messages,
 *                                    although it does not make sense to send persistent messages to a transient queue.

 * @param {boolean} options.exclusive Exclusive queues may only be accessed by the current connection,
 *                                    and are deleted when that connection closes.
 * @param {boolean} options.autoDelete If true, the queue is deleted when all consumers have finished using it.
 *                                     The last consumer can be cancelled either explicitly or because its channel is closed.
 *                                     If there was no consumer ever on the queue, it won't be deleted. Applications
 *                                     can explicitly delete auto-delete queues using the Delete method as normal.
 * @return {boolean}
 */


rpc.prototype.on = function(cmd, cb, context, options)    {
	debug('on(), routingKey=%s', cmd);
	if(this.__cmds[ cmd ]) return false;
	options || (options = {});

	var $this = this;

	this._connect(function()    {

        $this.__conn.queue({queue: options.queueName || cmd}, function(q) {
			q.declare(function(err, res){
				
				$this.__cmds[ cmd ] = { queue: q };
            	$this.__conn.consume(q.queueOptions.queue, function(packet)  {

                	var cmdInfo = {
                    	cmd:         packet.routingKey,
                    	exchange:    packet.exchange,
                    	contentType: packet.properties.contentType,
                    	size:        packet.size
                	};

                	if(packet.properties.correlationId &&  packet.properties.replyTo )    {

                	    return cb.call(context, message, function(err, data)   {

                    	    var options = {
                    	        correlationId: deliveryInfo.correlationId
                    	    }

                    	    $this.__exchange.publish(
                        	    packet.properties.replyTo,
                            	Array.prototype.slice.call(arguments),
                            	options
                        	);
                    	}, cmdInfo);
                	}
                	else
                    	return cb.call(context, message, null, cmdInfo);
            	});

            	$this._makeExchange(function(){
                	q.bind($this.__exchange_name, cmd);
            	});
			});
        });
    });


    return true;
}

/**
 * remove command handler added with "on" method
 * @param {string} cmd       command or match string
 * @return {boolean}
 */

rpc.prototype.off = function(cmd)    {
    debug('off', cmd);
    if(!this.__cmds[ cmd ]) return false;

    var $this = this;
    var c = $this.__cmds[ cmd ];

	if(c.queue){
		c.queue.unbind($this.__exchange, cmd, function(){
			c.queue.delete();
			delete $this.__cmds[ cmd ];
		});
	}
    return true;
}

/**
 * call broadcast
 * @param {string} cmd
 * @param params
 * @param options
 */


rpc.prototype.callBroadcast = function(cmd, params, options) {

    var $this = this;

    options || (options = {});
    options.broadcast = true;
    options.autoDeleteCallback = options.ttl ? false : true;
    var corr_id = this.call.call(this, cmd, params, options.onResponse, options.context, options);
    if(options.ttl) {
        setTimeout(function()   {
            //release cb
            if($this.__results_cb[ corr_id ]) {
                delete $this.__results_cb[ corr_id ];
            }
            options.onComplete.call(options.context, cmd, options);
        }, options.ttl);
    }
}

/**
 * subscribe to broadcast commands
 * @param {string} cmd
 * @param {function} cb
 * @param {object} context
 */

rpc.prototype.onBroadcast = function (cmd, cb, context, options) {

    options || (options = {});
    options.queueName = this.generateQueueName('broadcast:q'+ (queueNo++) );
    return this.on.call(this, cmd, cb, context, options);
}


/**
 *
 * @type {Function}
 */

rpc.prototype.offBroadcast = rpc.prototype.off;


module.exports.amqpRPC = rpc;

module.exports.factory = function(opt)  {
    return new rpc(opt);
}
