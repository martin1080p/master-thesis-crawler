import { handler } from './index.mjs';


console.log(await handler({
    Records: [{
        messageId: 'id1',
        body: 'alza.cz'
    }]
}));