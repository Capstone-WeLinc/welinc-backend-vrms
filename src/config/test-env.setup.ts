import { testEnv } from './env';

// Jest setupFiles (spec 0010, AC-9): every test sees the same valid environment, with or
// without a .env file, so importing AppModule never fails the boot check.
Object.assign(process.env, testEnv);
