import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { WHITE_CARDS, BLACK_CARDS, shuffleArray } from '../lib/cards';
import type { Game, GamePlayer } from '../lib/types';
import { Plus, LogOut, Users, Play, Trash2, Clock, MoreVertical, Skull } from 'lucide-react';

export default function Lobby() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [games, setGames] = useState<(Game & { players: GamePlayer[] })[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);

  const displayName = user?.user_metadata?.display_name || user?.email?.split('@')[0] || 'Anon';
  const avatarEmoji = user?.user_metadata?.avatar_emoji || '💀';

  useEffect(() => {
    fetchGames();
    const channel = supabase
      .channel('lobby')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games' }, () => fetchGames())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_players' }, () => fetchGames())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  async function fetchGames() {
    const { data: gamesData } = await supabase
      .from('games')
      .select('*')
      .in('state', ['waiting', 'active'])
      .order('created_at', { ascending: false });
    if (!gamesData) { setLoading(false); return; }

    const gamesWithPlayers = await Promise.all(
      gamesData.map(async (game) => {
        const { data: players } = await supabase.from('game_players').select('*').eq('game_id', game.id);
        return { ...game, players: players || [] } as Game & { players: GamePlayer[] };
      })
    );
    setGames(gamesWithPlayers);
    setLoading(false);
  }

  async function createGame() {
    if (!user) return;
    setCreating(true);

    const gameNumber = games.length + 1;
    // Shuffle both decks fresh for each new game
    const whiteDeck = shuffleArray(WHITE_CARDS);
    const blackDeck = shuffleArray(BLACK_CARDS);
    const hand = whiteDeck.slice(0, 10);
    const remaining = whiteDeck.slice(10);

    const { data: game, error } = await supabase
      .from('games')
      .insert({
        name: `Game ${gameNumber}`,
        state: 'waiting',
        deck: remaining,
        black_deck: blackDeck,
        created_by: user.id,
      })
      .select()
      .single();

    if (error || !game) { setCreating(false); return; }

    await supabase.from('game_players').insert({
      game_id: game.id,
      user_id: user.id,
      display_name: displayName,
      avatar_emoji: avatarEmoji,
      hand,
      is_ready: true,
    });

    setCreating(false);
    navigate(`/game/${game.id}`);
  }

  async function joinGame(gameId: string) {
    if (!user) return;
    const game = games.find((g) => g.id === gameId);
    if (!game) return;

    const alreadyIn = game.players.some((p) => p.user_id === user.id);
    if (alreadyIn) { navigate(`/game/${gameId}`); return; }

    // Always fetch the freshest deck to avoid dealing duplicate cards
    const { data: freshGame } = await supabase.from('games').select('deck').eq('id', gameId).maybeSingle();
    if (!freshGame) return;

    const deck = freshGame.deck as typeof WHITE_CARDS;
    const hand = deck.slice(0, 10);
    const remaining = deck.slice(10);

    await supabase.from('games').update({ deck: remaining }).eq('id', gameId);
    await supabase.from('game_players').insert({
      game_id: gameId,
      user_id: user.id,
      display_name: displayName,
      avatar_emoji: avatarEmoji,
      hand,
    });

    navigate(`/game/${gameId}`);
  }

  async function killGame(gameId: string) {
    await supabase.from('games').delete().eq('id', gameId);
    setMenuOpen(null);
  }

  function getStateLabel(state: string) {
    switch (state) {
      case 'waiting': return 'Waiting for players';
      case 'active': return 'In Progress';
      default: return state;
    }
  }

  function getStateColor(state: string) {
    switch (state) {
      case 'waiting': return 'text-yellow-400 bg-yellow-400/10';
      case 'active': return 'text-green-400 bg-green-400/10';
      default: return 'text-gray-400 bg-gray-400/10';
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <Skull className="w-8 h-8 text-red-500" />
            <h1 className="text-2xl font-black text-white">DEGENS</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-gray-400 text-sm hidden sm:block">{displayName}</span>
            <button onClick={signOut} className="text-gray-500 hover:text-white transition-colors p-2" title="Sign out">
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>

        <button
          onClick={createGame}
          disabled={creating}
          className="w-full bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-bold py-4 rounded-xl mb-6 transition-all hover:scale-[1.01] active:scale-[0.99] flex items-center justify-center gap-2"
        >
          <Plus className="w-5 h-5" />
          {creating ? 'Creating...' : 'Start New Game'}
        </button>

        <div className="space-y-3">
          {loading ? (
            <div className="text-center py-12 text-gray-500">Loading games...</div>
          ) : games.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-500 text-lg">No games running</p>
              <p className="text-gray-600 text-sm mt-1">Start one up, degen.</p>
            </div>
          ) : (
            games.map((game) => {
              const isInGame = game.players.some((p) => p.user_id === user?.id);
              return (
                <div key={game.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-gray-700 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3">
                        <h3 className="text-lg font-bold text-white">{game.name}</h3>
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${getStateColor(game.state)}`}>
                          {getStateLabel(game.state)}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 mt-1.5">
                        <span className="text-gray-400 text-sm flex items-center gap-1">
                          <Users className="w-3.5 h-3.5" />
                          {game.players.length} player{game.players.length !== 1 ? 's' : ''}
                        </span>
                        {game.state === 'active' && (
                          <span className="text-gray-400 text-sm flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5" />
                            Round {game.current_round}/{game.max_rounds}
                          </span>
                        )}
                      </div>
                      <div className="flex gap-1 mt-2 flex-wrap">
                        {game.players.map((p) => (
                          <span key={p.id} className="text-xs bg-gray-800 text-gray-300 px-2 py-0.5 rounded">{p.display_name}</span>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 ml-4">
                      {isInGame ? (
                        <button onClick={() => navigate(`/game/${game.id}`)} className="bg-green-600 hover:bg-green-700 text-white font-medium px-4 py-2 rounded-lg transition-colors flex items-center gap-1.5">
                          <Play className="w-4 h-4" /> Rejoin
                        </button>
                      ) : (
                        <button onClick={() => joinGame(game.id)} className="bg-blue-600 hover:bg-blue-700 text-white font-medium px-4 py-2 rounded-lg transition-colors flex items-center gap-1.5">
                          <Users className="w-4 h-4" /> Join
                        </button>
                      )}
                      <div className="relative">
                        <button onClick={() => setMenuOpen(menuOpen === game.id ? null : game.id)} className="text-gray-500 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors">
                          <MoreVertical className="w-4 h-4" />
                        </button>
                        {menuOpen === game.id && (
                          <div className="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-10 min-w-[140px]">
                            <button onClick={() => killGame(game.id)} className="w-full text-left px-4 py-2.5 text-red-400 hover:bg-gray-700 rounded-lg transition-colors flex items-center gap-2 text-sm">
                              <Trash2 className="w-4 h-4" /> Kill Game
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
