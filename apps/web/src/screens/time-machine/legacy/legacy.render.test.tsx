// @vitest-environment jsdom
import { verifyScreen } from '../../render-test-support';
import Loading from '../../shared-loading';
import ErrorBoundary from '../../shared-error';
import { descriptor } from './descriptor';
import View from './view';
verifyScreen(descriptor,[
  {state:'loading',name:'loads the compatibility route',render:()=> <Loading/>,text:''},
  {state:'error',name:'renders the safe compatibility error',render:()=> <ErrorBoundary error={Object.assign(new Error('Synthetic failure'),{digest:'synthetic-alias'})} reset={()=>{}}/>,text:'synthetic-alias'},
  {state:'ready',name:'identifies the destination in its fallback',render:()=> <View data={undefined as never}/>,text:'Redirecting to Change queue'},
]);
