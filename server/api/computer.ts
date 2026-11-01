import type {Express} from 'express';
import {registerComputer,pollComputer,receiveComputerReceipt,disconnectComputer} from '../domain/interaction/computer-bridge.js';
export function registerComputerRoutes(app:Express){
  app.post('/api/computer/register',(request,response,next)=>{try{response.json(registerComputer(request.body));}catch(error){next(error);}});
  app.post('/api/computer/poll',(request,response,next)=>{try{response.json(pollComputer(request.body?.deviceId,request.body?.token));}catch(error){next(error);}});
  app.post('/api/computer/receipt',(request,response,next)=>{try{response.json(receiveComputerReceipt(request.body));}catch(error){next(error);}});
  app.post('/api/computer/disconnect',(request,response,next)=>{try{response.json(disconnectComputer(request.body?.deviceId,request.body?.token));}catch(error){next(error);}});
}
