import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import sqlite3 from 'sqlite3'
import { open } from 'sqlite'
import { availableParallelism } from 'node:os'
import cluster from 'node:cluster'
import { createAdapter, setupPrimary } from '@socket.io/cluster-adapter'

if(cluster.isPrimary) {
	const numCPUs = availableParallelism()
	// create one worker per available core 
	for (let i = 0; i < numCPUs; i++) {
		cluster.fork({
			PORT: 3000 + i
		})
	}
	// set up the adapter on the primary thread
	setupPrimary()
} else {
	const app = express()
	const server = createServer(app)
	const io = new Server(server, {
		connectionStateRecovery: {},
		// set up the adapter on each worker thread
		adapter: createAdapter()
	})

	app.get('/', (req, res) => {
		res.sendFile(new URL('./public/index.html', import.meta.url).pathname)
	})

	io.on('connection', async (socket) => {
		socket.on('chat message', async (msg, clientOffset, callback) => {
			let result
			try {
				// store the message in the database
				result = await db.run('INSERT INTO messages (content, client_offset) VALUES (?, ?)', msg, clientOffset)
			}
			catch (error) {
				if(error.errno === 19 /*SQLITE_CONSTRAINT*/) {
					// the message was already inserted, so we notify the client
					callback()
				}
				else {
					// nothing to do, just let the client retry
				}
			} 
			// include the offset with the message
			io.emit('chat message', msg, result.lastID)
			// acknowledge the event
			callback()
		})

		if(!socket.recovered) {
			// if the connection state recovery was not succesful
			try {
				await db.each('SELECT id, content FROM messages WHERE id > ?',
					[socket.handshake.auth.serverOffset || 0],
					(_err, row) => {
						socket.emit('chat message', row.content, row.id)
					}
				)
			}
			catch (error) {
				throw new Error(error)
			}
		}
	})

	io.on('connection', (socket) => {
		socket.broadcast.emit('hi')
	})

	const port = process.env.PORT || 3000

	server.listen(port, () => {
		console.log(`Server running at http://localhost${port}`)
	})
}

// open the database file
const db = await open({
	filename: 'chat.db',
	driver: sqlite3.Database
})

await db.exec(`
	CREATE TABLE IF NOT EXISTS messages (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		client_offset TEXT UNIQUE,
		content TEXT
	)
`)

