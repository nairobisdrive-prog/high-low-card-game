import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { BLACK_CARDS, shuffleArray } from '../lib/cards';
import type { WhiteCard } from '../lib/cards';
import type { Game, GamePlayer, Round, Submission } from '../lib/types';
import { ArrowLeft, Crown, Check, Trophy, Users, Timer, Skull } from 'lucide-react';

export default function GameRoom() {
  const { gameId } = useParams<{ gameId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [game, setGame] = useState<Game | null>(null);
  const [players, setPlayers] = useState<GamePlayer[]>([]);
  const [currentRound, setCurrentRound] = useState<Round | null>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [selectedCards, setSelectedCards] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [showResults, setShowResults] = useState(false);

  const myPlayer = players.find((p) => p.user_id === user?.id);
  const isCzar = myPlayer?.is_czar ?? false;

  const fetchAll = useCallback(async () => {
    if (!gameId) return;

    const { data: gameData } = await supabase.from('games').select('*').eq('id', gameId).maybeSingle();
    if (gameData) setGame(gameData as Game);

    const { data: playersData } = await supabase.from('game_players').select('*').eq('game_id', gameId).order('joined_at');
    if (playersData) setPlayers(playersData as GamePlayer[]);

    const { data: roundData } = await supabase
      .from('rounds')
      .select('*')
      .eq('game_id', gameId)
      .order('round_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (roundData) {
      setCurrentRound(roundData as Round);
      const { data: subs } = await supabase.from('submissions').select('*').eq('round_id', roundData.id);
      if (subs) setSubmissions(subs as Submission[]);
    } else {
      setCurrentRound(null);
      setSubmissions([]);
    }
  }, [gameId]);

  useEffect(() => {
    fetchAll();

    const channel = supabase
      .channel(`game-${gameId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `id=eq.${gameId}` }, () => fetchAll())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_players', filter: `game_id=eq.${gameId}` }, () => fetchAll())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rounds', filter: `game_id=eq.${gameId}` }, () => fetchAll())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'submissions', filter: `game_id=eq.${gameId}` }, () => fetchAll())
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [gameId, fetchAll]);

  useEffect(() => {
    if (!currentRound || currentRound.status !== 'submitting') return;
    const activePlayers = players.filter((p) => !p.is_czar);
    if (activePlayers.length === 0) return;
    const allSubmitted = activePlayers.every((p) => p.has_submitted);
    if (allSubmitted && activePlayers.length > 0) {
      advanceToJudging();
    }
  }, [players, currentRound]);

  async function toggleReady() {
    if (!myPlayer) return;
    await supabase.from('game_players').update({ is_ready: !myPlayer.is_ready }).eq('id', myPlayer.id);
  }

  async function startGame() {
    if (!gameId || !user) return;
    const readyPlayers = players.filter((p) => p.is_ready);
    if (readyPlayers.length < 2) return;

    const rotation = shuffleArray(readyPlayers.map((p) => p.user_id));

    await supabase.from('games').update({
      state: 'active',
      current_round: 1,
      czar_rotation: rotation,
      czar_index: 0,
    }).eq('id', gameId);

    await startNewRound(rotation[0], 1);
  }

  async function startNewRound(czarUserId: string, roundNumber: number) {
    if (!gameId || !game) return;

    const blackCard = shuffleArray(BLACK_CARDS)[0];

    for (const p of players) {
      await supabase.from('game_players').update({
        is_czar: p.user_id === czarUserId,
        has_submitted: false,
      }).eq('id', p.id);
    }

    const timerEnd = new Date(Date.now() + 90 * 1000).toISOString();

    await supabase.from('rounds').insert({
      game_id: gameId,
      round_number: roundNumber,
      black_card: blackCard,
      status: 'submitting',
      czar_id: czarUserId,
      timer_ends_at: timerEnd,
    });

    setSelectedCards([]);
    setShowResults(false);
  }

  async function submitCards() {
    if (!myPlayer || !currentRound || !gameId || !user) return;
    if (selectedCards.length !== currentRound.black_card.pick) return;

    setSubmitting(true);

    const cards = selectedCards.map((id) => myPlayer.hand.find((c) => c.id === id)!);

    await supabase.from('submissions').insert({
      round_id: currentRound.id,
      game_id: gameId,
      player_id: myPlayer.id,
      user_id: user.id,
      cards,
    });

    const newHand = myPlayer.hand.filter((c) => !selectedCards.includes(c.id));
    await supabase.from('game_players').update({
      has_submitted: true,
      hand: newHand,
    }).eq('id', myPlayer.id);

    setSelectedCards([]);
    setSubmitting(false);
  }

  async function advanceToJudging() {
    if (!currentRound) return;
    await supabase.from('rounds').update({ status: 'judging' }).eq('id', currentRound.id);
  }

  async function pickWinner(submissionId: string) {
    if (!currentRound || !gameId || !game) return;

    const winnerSub = submissions.find((s) => s.id === submissionId);
    if (!winnerSub) return;

    await supabase.from('submissions').update({ is_winner: true }).eq('id', submissionId);
    await supabase.from('rounds').update({ status: 'finished', winner_id: winnerSub.user_id }).eq('id', currentRound.id);

    const winnerPlayer = players.find((p) => p.user_id === winnerSub.user_id);
    if (winnerPlayer) {
      await supabase.from('game_players').update({ score: winnerPlayer.score + 1 }).eq('id', winnerPlayer.id);
    }

    setShowResults(true);

    if (game.current_round >= game.max_rounds) {
      await supabase.from('games').update({ state: 'finished' }).eq('id', gameId);
    }
  }

  async function nextRound() {
    if (!game || !gameId) return;

    const nextRoundNum = game.current_round + 1;
    const rotation = game.czar_rotation as string[];
    const nextCzarIdx = (game.czar_index + 1) % rotation.length;
    const nextCzar = rotation[nextCzarIdx];

    let deck = game.deck as WhiteCard[];
    for (const p of players) {
      const cardsNeeded = 10 - (p.hand as WhiteCard[]).length;
      if (cardsNeeded > 0) {
        if (deck.length < cardsNeeded) {
          deck = shuffleArray([...deck, ...(game.discard_pile as WhiteCard[])]);
          await supabase.from('games').update({ discard_pile: [] }).eq('id', gameId);
        }
        const newCards = deck.slice(0, cardsNeeded);
        deck = deck.slice(cardsNeeded);
        const newHand = [...(p.hand as WhiteCard[]), ...newCards];
        await supabase.from('game_players').update({ hand: newHand }).eq('id', p.id);
      }
    }

    await supabase.from('games').update({
      current_round: nextRoundNum,
      czar_index: nextCzarIdx,
      deck,
    }).eq('id', gameId);

    await startNewRound(nextCzar, nextRoundNum);
  }

  async function leaveGame() {
    if (!myPlayer || !gameId) return;
    await supabase.from('game_players').delete().eq('id', myPlayer.id);
    navigate('/');
  }

  if (!game || !gameId) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (game.state === 'finished') {
    const sorted = [...players].sort((a, b) => b.score - a.score);
    return (
      <div className="min-h-screen bg-gray-950 p-4 md:p-8">
        <div className="max-w-lg mx-auto text-center">
          <Trophy className="w-16 h-16 text-yellow-400 mx-auto mb-4" />
          <h1 className="text-3xl font-black text-white mb-2">Game Over!</h1>
          <p className="text-gray-400 mb-8">
            {sorted[0]?.display_name} wins with {sorted[0]?.score} points!
          </p>
          <div className="space-y-2 mb-8">
            {sorted.map((p, i) => (
              <div key={p.id} className="bg-gray-900 border border-gray-800 rounded-lg p-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-lg font-bold text-gray-500 w-6">{i + 1}</span>
                  <span className="text-white font-medium">{p.display_name}</span>
                </div>
                <span className="text-yellow-400 font-bold">{p.score} pts</span>
              </div>
            ))}
          </div>
          <button onClick={() => navigate('/')} className="bg-red-600 hover:bg-red-700 text-white font-bold px-6 py-3 rounded-lg transition-colors">
            Back to Lobby
          </button>
        </div>
      </div>
    );
  }

  if (game.state === 'waiting') {
    const readyCount = players.filter((p) => p.is_ready).length;
    return (
      <div className="min-h-screen bg-gray-950 p-4 md:p-8">
        <div className="max-w-lg mx-auto">
          <div className="flex items-center gap-3 mb-6">
            <button onClick={() => navigate('/')} className="text-gray-500 hover:text-white transition-colors">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h1 className="text-2xl font-black text-white">{game.name}</h1>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-4">
            <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
              <Users className="w-5 h-5 text-gray-400" />
              Players ({players.length})
            </h2>
            <div className="space-y-2">
              {players.map((p) => (
                <div key={p.id} className="flex items-center justify-between bg-gray-800 rounded-lg px-4 py-2.5">
                  <span className="text-white font-medium">{p.display_name}</span>
                  {p.is_ready ? (
                    <span className="text-green-400 text-sm flex items-center gap-1">
                      <Check className="w-4 h-4" /> Ready
                    </span>
                  ) : (
                    <span className="text-gray-500 text-sm">Not ready</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={toggleReady}
              className={`flex-1 font-bold py-3 rounded-lg transition-colors ${
                myPlayer?.is_ready
                  ? 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                  : 'bg-green-600 hover:bg-green-700 text-white'
              }`}
            >
              {myPlayer?.is_ready ? 'Unready' : 'Ready Up'}
            </button>

            {readyCount >= 2 && (
              <button
                onClick={startGame}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                <Skull className="w-5 h-5" />
                Start Game ({readyCount} ready)
              </button>
            )}
          </div>

          <button
            onClick={leaveGame}
            className="w-full mt-3 text-gray-500 hover:text-red-400 text-sm py-2 transition-colors"
          >
            Leave Game
          </button>
        </div>
      </div>
    );
  }

  const roundStatus = currentRound?.status ?? 'submitting';
  const winnerSubmission = submissions.find((s) => s.is_winner);
  const winnerPlayer = winnerSubmission ? players.find((p) => p.user_id === winnerSubmission.user_id) : null;

  return (
    <div className="min-h-screen bg-gray-950 p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/')} className="text-gray-500 hover:text-white transition-colors">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h1 className="text-lg font-bold text-white">{game.name}</h1>
            <span className="text-gray-500 text-sm">Round {game.current_round}/{game.max_rounds}</span>
          </div>
          <div className="flex items-center gap-2">
            {players.sort((a, b) => b.score - a.score).slice(0, 3).map((p) => (
              <span key={p.id} className="text-xs bg-gray-800 text-gray-300 px-2 py-1 rounded flex items-center gap-1">
                {p.is_czar && <Crown className="w-3 h-3 text-yellow-400" />}
                {p.display_name}: {p.score}
              </span>
            ))}
          </div>
        </div>

        {currentRound && (
          <div className="bg-black border-2 border-gray-700 rounded-xl p-6 mb-6">
            <p className="text-white text-xl md:text-2xl font-bold leading-relaxed">
              {currentRound.black_card.text}
            </p>
            <div className="mt-3 flex items-center gap-2">
              <span className="text-gray-400 text-sm">Pick {currentRound.black_card.pick}</span>
              {currentRound.timer_ends_at && roundStatus === 'submitting' && (
                <CountdownTimer endsAt={currentRound.timer_ends_at} />
              )}
            </div>
          </div>
        )}

        {roundStatus === 'submitting' && (
          <div className="mb-4">
            {isCzar ? (
              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 text-yellow-300 text-center">
                <Crown className="w-6 h-6 mx-auto mb-1" />
                You are the Card Czar. Wait for submissions...
                <div className="text-sm text-yellow-400/70 mt-1">
                  {players.filter((p) => !p.is_czar && p.has_submitted).length}/{players.filter((p) => !p.is_czar).length} submitted
                </div>
              </div>
            ) : myPlayer?.has_submitted ? (
              <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4 text-green-300 text-center">
                <Check className="w-6 h-6 mx-auto mb-1" />
                Cards submitted! Waiting for others...
                <div className="text-sm text-green-400/70 mt-1">
                  {players.filter((p) => !p.is_czar && p.has_submitted).length}/{players.filter((p) => !p.is_czar).length} submitted
                </div>
              </div>
            ) : (
              <p className="text-gray-400 text-sm mb-2">
                Select {currentRound?.black_card.pick} card{currentRound?.black_card.pick !== 1 ? 's' : ''} from your hand:
              </p>
            )}
          </div>
        )}

        {roundStatus === 'judging' && !showResults && (
          <div className="mb-6">
            <p className="text-gray-300 font-medium mb-3">
              {isCzar ? 'Pick the winner:' : 'The Czar is choosing...'}
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              {submissions.map((sub) => (
                <button
                  key={sub.id}
                  onClick={() => isCzar && pickWinner(sub.id)}
                  disabled={!isCzar}
                  className={`text-left bg-white rounded-xl p-4 transition-all ${
                    isCzar ? 'hover:scale-[1.02] hover:shadow-lg cursor-pointer' : 'cursor-default'
                  }`}
                >
                  {(sub.cards as WhiteCard[]).map((card, i) => (
                    <p key={i} className="text-gray-900 font-medium text-lg">
                      {card.text}
                    </p>
                  ))}
                </button>
              ))}
            </div>
          </div>
        )}

        {roundStatus === 'finished' && (
          <div className="mb-6">
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-6 text-center mb-4">
              <Trophy className="w-8 h-8 text-yellow-400 mx-auto mb-2" />
              <p className="text-yellow-300 font-bold text-lg">{winnerPlayer?.display_name} wins this round!</p>
              {winnerSubmission && (
                <div className="mt-2 bg-white rounded-lg p-3 inline-block">
                  {(winnerSubmission.cards as WhiteCard[]).map((card, i) => (
                    <p key={i} className="text-gray-900 font-bold">{card.text}</p>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={nextRound}
              className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-lg transition-colors"
            >
              Next Round
            </button>
          </div>
        )}

        {roundStatus === 'submitting' && !isCzar && !myPlayer?.has_submitted && myPlayer && (
          <div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2 mb-4">
              {(myPlayer.hand as WhiteCard[]).map((card) => {
                const isSelected = selectedCards.includes(card.id);
                return (
                  <button
                    key={card.id}
                    onClick={() => {
                      if (isSelected) {
                        setSelectedCards(selectedCards.filter((id) => id !== card.id));
                      } else if (selectedCards.length < (currentRound?.black_card.pick ?? 1)) {
                        setSelectedCards([...selectedCards, card.id]);
                      }
                    }}
                    className={`bg-white rounded-xl p-3 text-left transition-all hover:scale-[1.03] ${
                      isSelected ? 'ring-3 ring-red-500 shadow-lg shadow-red-500/20 scale-[1.03]' : 'hover:shadow-md'
                    }`}
                  >
                    <p className="text-gray-900 font-medium text-sm leading-tight">{card.text}</p>
                  </button>
                );
              })}
            </div>

            {selectedCards.length === (currentRound?.black_card.pick ?? 1) && (
              <button
                onClick={submitCards}
                disabled={submitting}
                className="w-full bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-bold py-3 rounded-xl transition-colors"
              >
                {submitting ? 'Submitting...' : 'Submit Cards'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CountdownTimer({ endsAt }: { endsAt: string }) {
  const [timeLeft, setTimeLeft] = useState('');

  useEffect(() => {
    const update = () => {
      const diff = new Date(endsAt).getTime() - Date.now();
      if (diff <= 0) {
        setTimeLeft('0:00');
        return;
      }
      const mins = Math.floor(diff / 60000);
      const secs = Math.floor((diff % 60000) / 1000);
      setTimeLeft(`${mins}:${secs.toString().padStart(2, '0')}`);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [endsAt]);

  return (
    <span className="text-gray-400 text-sm flex items-center gap-1">
      <Timer className="w-3.5 h-3.5" />
      {timeLeft}
    </span>
  );
}
