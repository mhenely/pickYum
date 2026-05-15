import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { api, AuthUser } from '../../lib/api';

interface AuthState {
  user: AuthUser | null;
  status: 'idle' | 'loading' | 'authenticated' | 'unauthenticated';
  error: string | null;
}

const initialState: AuthState = {
  user: null,
  status: 'idle',
  error: null,
};

export const checkAuth = createAsyncThunk('auth/checkAuth', async () => {
  const { user } = await api.auth.me();
  return user;
});

export const loginUser = createAsyncThunk(
  'auth/login',
  async (credentials: { email: string; password: string }, { rejectWithValue }) => {
    try {
      const { user } = await api.auth.login(credentials);
      return user;
    } catch (err) {
      return rejectWithValue((err as Error).message);
    }
  }
);

export const registerUser = createAsyncThunk(
  'auth/register',
  async (data: { email: string; username: string; password: string }, { rejectWithValue }) => {
    try {
      const { user } = await api.auth.register(data);
      return user;
    } catch (err) {
      return rejectWithValue((err as Error).message);
    }
  }
);

export const logoutUser = createAsyncThunk('auth/logout', async () => {
  await api.auth.logout();
});

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      // checkAuth
      .addCase(checkAuth.pending, (state) => {
        state.status = 'loading';
        state.error = null;
      })
      .addCase(checkAuth.fulfilled, (state, action) => {
        state.user = action.payload;
        state.status = 'authenticated';
      })
      .addCase(checkAuth.rejected, (state) => {
        state.user = null;
        state.status = 'unauthenticated';
      })
      // login
      .addCase(loginUser.pending, (state) => {
        state.status = 'loading';
        state.error = null;
      })
      .addCase(loginUser.fulfilled, (state, action) => {
        state.user = action.payload;
        state.status = 'authenticated';
        state.error = null;
      })
      .addCase(loginUser.rejected, (state, action) => {
        state.status = 'unauthenticated';
        state.error = action.payload as string;
      })
      // register
      .addCase(registerUser.pending, (state) => {
        state.status = 'loading';
        state.error = null;
      })
      .addCase(registerUser.fulfilled, (state, action) => {
        state.user = action.payload;
        state.status = 'authenticated';
        state.error = null;
      })
      .addCase(registerUser.rejected, (state, action) => {
        state.status = 'unauthenticated';
        state.error = action.payload as string;
      })
      // logout — succeed and fail both wipe local state. A 5xx on the API
      // call shouldn't leave the user appearing logged-in (Redux still
      // populated with favorites/options/etc.) when they clicked Log Out.
      // The cookie isn't cleared server-side in that case, but checkAuth on
      // next mount will resolve cleanly: if the cookie is still valid the
      // user is re-authenticated; if not, we land in 'unauthenticated'. The
      // worst case is a stale session cookie that the server eventually
      // rejects — far better than visible data persistence on shared devices.
      .addCase(logoutUser.fulfilled, (state) => {
        state.user = null;
        state.status = 'unauthenticated';
      })
      .addCase(logoutUser.rejected, (state) => {
        state.user = null;
        state.status = 'unauthenticated';
      });
  },
});

export default authSlice.reducer;
