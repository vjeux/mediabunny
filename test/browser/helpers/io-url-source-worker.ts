import { Reader } from '../../../src/reader.js';
import { UrlSource } from '../../../src/source.js';

// Reads the first byte of the URL it gets and reports how that went
self.onmessage = async (event: MessageEvent<string>) => {
	const reader = new Reader(new UrlSource(event.data));

	try {
		await reader.requestSlice(0, 1);
		self.postMessage('resolved');
	} catch (error) {
		self.postMessage(`rejected: ${String(error)}`);
	}
};
