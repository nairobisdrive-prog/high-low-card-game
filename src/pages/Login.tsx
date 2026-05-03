import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { LogIn, UserPlus, Skull } from 'lucide-react';

export default function Login() {
  const { signIn, signUp } = useAuth();
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [avatarEmoji, setAvatarEmoji] = useState('💀');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const AVATAR_OPTIONS = ['💀','👻','🤡','😈','🦄','🐙','🔥','🌮','🍕','🍆','🦝','🐸','🪦','🪩','🎲','🎯','🦴','👹','🧌','🐀'];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    if (isRegister) {
      if (!displayName.trim()) {
        setError('Display name is required');
        setLoading(false);
        return;
      }
      const { error } = await signUp(email, password, displayName, avatarEmoji);
      if (error) setError(error);
    } else {
      const { error } = await signIn(email, password);
      if (error) setError(error);
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-3 mb-4">
            <Skull className="w-10 h-10 text-red-500" />
            <h1 className="text-4xl font-black text-white tracking-tight">DEGENS</h1>
            <Skull className="w-10 h-10 text-red-500" />
          </div>
          <p className="text-gray-400 text-sm">A horrible card game for horrible people</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
          <h2 className="text-xl font-bold text-white">
            {isRegister ? 'Create Account' : 'Sign In'}
          </h2>

          {isRegister && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Display Name</label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
                  placeholder="Your degen name"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Pick your avatar</label>
                <div className="grid grid-cols-10 gap-1.5 bg-gray-800 border border-gray-700 rounded-lg p-2">
                  {AVATAR_OPTIONS.map((e) => (
                    <button
                      key={e}
                      type="button"
                      onClick={() => setAvatarEmoji(e)}
                      className={`text-2xl rounded-md aspect-square transition-all ${
                        avatarEmoji === e ? 'bg-red-600 ring-2 ring-red-400 scale-110' : 'hover:bg-gray-700'
                      }`}
                      aria-label={`avatar ${e}`}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
              placeholder="degen@example.com"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
              placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"
              required
              minLength={6}
            />
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-red-400 text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-bold py-3 rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            {loading ? (
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : isRegister ? (
              <>
                <UserPlus className="w-5 h-5" />
                Create Account
              </>
            ) : (
              <>
                <LogIn className="w-5 h-5" />
                Sign In
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => { setIsRegister(!isRegister); setError(''); }}
            className="w-full text-gray-400 hover:text-white text-sm transition-colors"
          >
            {isRegister ? 'Already have an account? Sign in' : "Don't have an account? Register"}
          </button>
        </form>
      </div>
    </div>
  );
}
