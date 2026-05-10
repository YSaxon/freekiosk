import React from 'react';
import { StatusBar } from 'react-native';
import AppNavigator from './src/navigation/AppNavigator';
import AppLockGate from './src/components/AppLockGate';

const App: React.FC = () => {
  return (
    <>
      <StatusBar hidden={true} />
      <AppLockGate>
        <AppNavigator />
      </AppLockGate>
    </>
  );
};

export default App;
