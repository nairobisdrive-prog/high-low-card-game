import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { BLACK_CARDS, shuffleArray } from '../lib/cards';
import type { WhiteCard, BlackCard } from '../lib/cards';
import type { Game, GamePlayer, Round, Submission } from '../lib/types';
import { ArrowLeft, Crown, Check, Trophy, Users, Timer, Skull, ThumbsUp } from 'lucide-react';

const VOTING_MODE_MAX_PLAYERS = 3;

// Reusable card text renderer — shows English text with optional Spanish subtitle
function CardText({ card, className = '' }: { card: WhiteCard | BlackCard; className?: string }) {
  return (
    <span className={className}>
      {card.text}
      {card.text_es && (
        <span className="block mt-1 opacity-60" style={{ fontSize: '0.8em' }}>({card.text_es})</span>
      )}
    </span>
  );
}

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
  const [canSummonRando, setCanSummonRando] = useState(false);

  const advancingRef = useRef(false);

  const myPlayer = players.find((p) => p.user_id === user?.id);
  const isVotingMode = (game?.democratic_mode ?? false) || players.length <= VOTING_MODE_MAX_PLAYERS;
  const isCzar = !isVotingMode && (myPlayer?.is_czar ?? false);
  const myVotedSubmissionId = submissions.find(
    (s) => (s.voter_ids as string[]).includes(user?.id ?? '')
  )?.id ?? null;
  const hasVoted = myVotedSubmissionId !== null;

  const fetchAll = useCallback(async () => {
    if (!gameId) return;
    const { data: gameData } = await supabase.from('games').select('*').eq('id', gameId).maybeSingle();
    if (gameData) setGame(gameData as Game);

    const { data: playersData } = await supabase.from('game_players').select('*').eq('game_id', gameId).order('joined_at');
    if (playersData) setPlayers(playersData as GamePlayer[]);

    const { data: roundData } = await supabase
      .from('rounds').select('*').eq('game_id', gameId)
      .order('round_number', { ascending: false }).limit(1).maybeSingle();
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
    if (!user || !game) return;
    if (game.rando_enabled) { setCanSummonRando(false); return; }
    (async () => {
      const { data: history } = await supabase
        .from('game_players')
        .select('game_id, activated_rando, joined_at')
        .eq('user_id', user.id)
        .order('joined_at', { ascending: false });
      if (!history) return;
      const lastIdx = history.findIndex((h) => h.activated_rando);
      setCanSummonRando(lastIdx === -1 || lastIdx >= 3);
    })();
  }, [user, game]);

  async function summonRando() {
    if (!gameId || !myPlayer || !canSummonRando) return;
    await supabase.from('games').update({ rando_enabled: true }).eq('id', gameId);
    await supabase.from('game_players').update({ activated_rando: true }).eq('id', myPlayer.id);
    setCanSummonRando(false);
  }

  useEffect(() => {
    if (advancingRef.current) return;
    if (!currentRound || currentRound.status !== 'submitting') return;
    const submitters = isVotingMode ? players : players.filter((p) => !p.is_czar);
    if (submitters.length === 0) return;
    const submittedUserIds = new Set(submissions.map((s) => s.user_id));
    const allDone = submitters.every((p) => p.has_submitted && submittedUserIds.has(p.user_id));
    if (allDone) advanceToJudging();
  }, [players, submissions, currentRound, isVotingMode]);

  // Server-truth timer cutoff: host's tab force-advances when timer expires
  useEffect(() => {
    if (!game || !currentRound || currentRound.status !== 'submitting') return;
    if (!currentRound.timer_ends_at) return;
    if (user?.id !== game.created_by) return;
    const msLeft = new Date(currentRound.timer_ends_at).getTime() - Date.now();
    const t = setTimeout(async () => {
      const { data: latest } = await supabase
        .from('rounds').select('status').eq('id', currentRound.id).maybeSingle();
      if (!latest || latest.status !== 'submitting') return;
      const { data: subs } = await supabase
        .from('submissions').select('id').eq('round_id', currentRound.id);
      if (!subs || subs.length === 0) {
        await supabase.from('rounds').update({ status: 'finished' }).eq('id', currentRound.id);
      } else {
        await supabase.from('rounds').update({ status: 'judging' }).eq('id', currentRound.id);
      }
    }, Math.max(0, msLeft));
    return () => clearTimeout(t);
  }, [currentRound, game, user]);

  useEffect(() => {
    if (!currentRound || currentRound.status !== 'judging' || !isVotingMode) return;
    if (submissions.length === 0) return;
    const totalVotes = submissions.reduce((sum, s) => sum + (s.voter_ids as string[]).length, 0);
    if (totalVotes >= players.length) resolveVoting();
  }, [submissions, currentRound, isVotingMode, players.length]);

  async function toggleReady() {
    if (!myPlayer) return;
    await supabase.from('game_players').update({ is_ready: !myPlayer.is_ready }).eq('id', myPlayer.id);
  }

  async function startGame() {
    if (!gameId || !user) return;
    const readyPlayers = players.filter((p) => p.is_ready);
    if (readyPlayers.length < 2) return;

    const useVotingMode = readyPlayers.length <= VOTING_MODE_MAX_PLAYERS;
    const rotation = useVotingMode ? [] : shuffleArray(readyPlayers.map((p) => p.user_id));

    await supabase.from('games').update({
      state: 'active',
      current_round: 1,
      czar_rotation: rotation,
      czar_index: 0,
    }).eq('id', gameId);

    await beginRound({
      czarUserId: useVotingMode ? null : rotation[0],
      roundNumber: 1,
      activePlayers: readyPlayers,
      replenishHands: false,
    });
  }

  async function beginRound({
    czarUserId,
    roundNumber,
    activePlayers,
    replenishHands,
  }: {
    czarUserId: string | null;
    roundNumber: number;
    activePlayers?: GamePlayer[];
    replenishHands: boolean;
  }) {
    if (!gameId) return;
    const currentPlayers = activePlayers ?? players;

    for (const p of currentPlayers) {
      await supabase.from('game_players').update({
        is_czar: czarUserId !== null && p.user_id === czarUserId,
        has_submitted: false,
      }).eq('id', p.id);
    }

    if (replenishHands) {
      const { data: freshGame } = await supabase
        .from('games').select('deck, discard_pile').eq('id', gameId).maybeSingle();
      let liveDeck = (freshGame?.deck as WhiteCard[]) ?? [];
      let liveDiscard = (freshGame?.discard_pile as WhiteCard[]) ?? [];

      const { data: roundSubs } = await supabase
        .from('submissions').select('cards')
        .in('round_id', [...(currentRound?.id ? [currentRound.id] : [])]);
      const playedCards: WhiteCard[] = (roundSubs ?? []).flatMap((s) => s.cards as WhiteCard[]);
      liveDiscard = [...liveDiscard, ...playedCards];

      for (const p of currentPlayers) {
        const currentHand = p.hand as WhiteCard[];
        let needed = 10 - currentHand.length;
        if (needed <= 0) continue;

        const newCards: WhiteCard[] = [];
        while (needed > 0) {
          if (liveDeck.length === 0) {
            if (liveDiscard.length === 0) break;
            liveDeck = shuffleArray(liveDiscard);
            liveDiscard = [];
          }
          const take = Math.min(needed, liveDeck.length);
          newCards.push(...liveDeck.slice(0, take));
          liveDeck = liveDeck.slice(take);
          needed -= take;
        }

        await supabase.from('game_players').update({
          hand: [...currentHand, ...newCards],
        }).eq('id', p.id);
      }

      await supabase.from('games').update({ deck: liveDeck, discard_pile: liveDiscard }).eq('id', gameId);
    }

    const { data: freshGame2 } = await supabase
      .from('games').select('black_deck, deck, discard_pile, ghost_card_enabled, rando_enabled, speed_round, created_by').eq('id', gameId).maybeSingle();
    let blackDeck = (freshGame2?.black_deck as BlackCard[]) ?? [];
    if (blackDeck.length === 0) blackDeck = shuffleArray(BLACK_CARDS);
    const blackCard = blackDeck[0];
    const remainingBlackDeck = blackDeck.slice(1);
    await supabase.from('games').update({ black_deck: remainingBlackDeck }).eq('id', gameId);

    const timerSeconds = freshGame2?.speed_round ? 90 : 120;
    const timerEnd = new Date(Date.now() + timerSeconds * 1000).toISOString();
    const { data: insertedRound } = await supabase.from('rounds').insert({
      game_id: gameId,
      round_number: roundNumber,
      black_card: blackCard,
      status: 'submitting',
      czar_id: czarUserId,
      timer_ends_at: timerEnd,
    }).select().single();

    // Ghost card: ~15% chance one random non-czar player gets an auto-played card
    const ghostEnabled = freshGame2?.ghost_card_enabled ?? false;
    if (ghostEnabled && insertedRound && Math.random() < 0.15) {
      const eligible = currentPlayers.filter((p) => p.user_id !== czarUserId);
      if (eligible.length > 0) {
        let ghostDeck = (freshGame2?.deck as WhiteCard[]) ?? [];
        let ghostDiscard = (freshGame2?.discard_pile as WhiteCard[]) ?? [];
        const ghostCards: WhiteCard[] = [];
        let need = blackCard.pick;
        while (need > 0) {
          if (ghostDeck.length === 0) {
            if (ghostDiscard.length === 0) break;
            ghostDeck = shuffleArray(ghostDiscard);
            ghostDiscard = [];
          }
          ghostCards.push(ghostDeck[0]);
          ghostDeck = ghostDeck.slice(1);
          need -= 1;
        }
        if (ghostCards.length === blackCard.pick) {
          const ghostPlayer = eligible[Math.floor(Math.random() * eligible.length)];
          await supabase.from('submissions').insert({
            round_id: insertedRound.id,
            game_id: gameId,
            player_id: ghostPlayer.id,
            user_id: ghostPlayer.user_id,
            cards: ghostCards,
            is_ghost: true,
          });
          await supabase.from('game_players').update({ has_submitted: true }).eq('id', ghostPlayer.id);
          await supabase.from('games').update({ deck: ghostDeck, discard_pile: ghostDiscard }).eq('id', gameId);
        }
      }
    }

    // Rando Cardrissian: every round inserts an extra fake submission
    const randoEnabled = freshGame2?.rando_enabled ?? false;
    if (randoEnabled && insertedRound) {
      const { data: latestGame } = await supabase
        .from('games').select('deck, discard_pile').eq('id', gameId).maybeSingle();
      let rDeck = (latestGame?.deck as WhiteCard[]) ?? [];
      let rDiscard = (latestGame?.discard_pile as WhiteCard[]) ?? [];
      const rCards: WhiteCard[] = [];
      let rNeed = blackCard.pick;
      while (rNeed > 0) {
        if (rDeck.length === 0) {
          if (rDiscard.length === 0) break;
          rDeck = shuffleArray(rDiscard);
          rDiscard = [];
        }
        rCards.push(rDeck[0]);
        rDeck = rDeck.slice(1);
        rNeed -= 1;
      }
      if (rCards.length === blackCard.pick) {
        await supabase.from('submissions').insert({
          round_id: insertedRound.id,
          game_id: gameId,
          player_id: null,
          user_id: freshGame2?.created_by,
          cards: rCards,
          is_rando: true,
        });
        await supabase.from('games').update({ deck: rDeck, discard_pile: rDiscard }).eq('id', gameId);
      }
    }

    setSelectedCards([]);
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
    await supabase.from('game_players').update({ has_submitted: true, hand: newHand }).eq('id', myPlayer.id);

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
    await supabase.from('rounds').update({ status: 'finished', winner_id: winnerSub.is_rando ? null : winnerSub.user_id }).eq('id', currentRound.id);

    if (winnerSub.is_rando) {
      for (const p of players) {
        await supabase.from('game_players').update({ score: p.score - 1 }).eq('id', p.id);
      }
    } else {
      const winnerPlayer = players.find((p) => p.user_id === winnerSub.user_id);
      if (winnerPlayer) {
        const points = winnerSub.is_ghost ? 3 : 1;
        await supabase.from('game_players').update({ score: winnerPlayer.score + points }).eq('id', winnerPlayer.id);
      }
    }
    if (game.current_round >= game.max_rounds) {
      await supabase.from('games').update({ state: 'finished' }).eq('id', gameId);
    }
  }

  async function castVote(submissionId: string) {
    if (!user || !currentRound || hasVoted) return;
    const sub = submissions.find((s) => s.id === submissionId);
    if (!sub) return;
    await supabase.from('submissions').update({
      votes: sub.votes + 1,
      voter_ids: [...(sub.voter_ids as string[]), user.id],
    }).eq('id', submissionId);
  }

  async function resolveVoting() {
    if (!currentRound || !gameId || !game) return;
    const maxVotes = Math.max(...submissions.map((s) => s.votes));
    const winners = submissions.filter((s) => s.votes === maxVotes);
    const pointEach = winners.length > 1 ? 0.5 : 1;

    for (const winnerSub of winners) {
      await supabase.from('submissions').update({ is_winner: true }).eq('id', winnerSub.id);
      if (winnerSub.is_rando) {
        for (const p of players) {
          await supabase.from('game_players').update({ score: p.score - pointEach }).eq('id', p.id);
        }
      } else {
        const winnerPlayer = players.find((p) => p.user_id === winnerSub.user_id);
        if (winnerPlayer) {
          const bonus = winnerSub.is_ghost ? 3 : 1;
          await supabase.from('game_players').update({ score: winnerPlayer.score + bonus * pointEach }).eq('id', winnerPlayer.id);
        }
      }
    }

    await supabase.from('rounds').update({
      status: 'finished',
      winner_id: winners[0].is_rando ? null : winners[0].user_id,
    }).eq('id', currentRound.id);

    if (game.current_round >= game.max_rounds) {
      await supabase.from('games').update({ state: 'finished' }).eq('id', gameId);
    }
  }

  async function nextRound() {
    if (!game || !gameId) return;
    if (advancingRef.current) return;
    advancingRef.current = true;

    const nextRoundNum = game.current_round + 1;
    const { data: latest } = await supabase
      .from('rounds').select('round_number').eq('game_id', gameId)
      .order('round_number', { ascending: false }).limit(1).maybeSingle();
    if (latest && latest.round_number >= nextRoundNum) {
      advancingRef.current = false;
      return;
    }

    const useVotingMode = (game.democratic_mode ?? false) || players.length <= VOTING_MODE_MAX_PLAYERS;
    const rotation = game.czar_rotation as string[];
    let nextCzarIdx = (game.czar_index + 1) % (rotation.length || 1);
    let nextCzar = useVotingMode ? null : (rotation[nextCzarIdx] ?? null);

    if (!useVotingMode && game.meritocracy_enabled && currentRound?.winner_id) {
      nextCzar = currentRound.winner_id;
      const winnerIdx = rotation.indexOf(currentRound.winner_id);
      if (winnerIdx !== -1) nextCzarIdx = winnerIdx;
    }

    await supabase.from('games').update({
      current_round: nextRoundNum,
      czar_index: nextCzarIdx,
    }).eq('id', gameId);

    await beginRound({
      czarUserId: nextCzar,
      roundNumber: nextRoundNum,
      replenishHands: true,
    });

    advancingRef.current = false;
  }

  async function leaveGame() {
    if (!myPlayer || !gameId) return;
    if (game?.state === 'active' && !confirm('Leave the game? Your cards go back into the deck and you forfeit your score.')) return;

    if (game?.state === 'active') {
      const { data: freshGame } = await supabase
        .from('games').select('discard_pile, czar_rotation, czar_index').eq('id', gameId).maybeSingle();
      if (freshGame) {
        const discard = [...((freshGame.discard_pile as WhiteCard[]) ?? []), ...(myPlayer.hand as WhiteCard[])];
        const rotation = (freshGame.czar_rotation as string[]) ?? [];
        const leavingIdx = rotation.indexOf(myPlayer.user_id);
        const newRotation = rotation.filter((id) => id !== myPlayer.user_id);
        let newCzarIdx = freshGame.czar_index ?? 0;
        if (leavingIdx !== -1 && leavingIdx < newCzarIdx) newCzarIdx -= 1;
        if (newRotation.length > 0) newCzarIdx = newCzarIdx % newRotation.length;
        await supabase.from('games').update({
          discard_pile: discard,
          czar_rotation: newRotation,
          czar_index: newCzarIdx,
        }).eq('id', gameId);
      }
    }

    if (
      game?.state === 'active' &&
      !isVotingMode &&
      currentRound &&
      currentRound.status !== 'finished' &&
      currentRound.czar_id === myPlayer.user_id
    ) {
      const candidates = players.filter((p) => p.user_id !== myPlayer.user_id);
      if (candidates.length > 0) {
        const newCzar = candidates[Math.floor(Math.random() * candidates.length)];
        await supabase.from('rounds').update({ czar_id: newCzar.user_id }).eq('id', currentRound.id);
        await supabase.from('game_players').update({ is_czar: true }).eq('id', newCzar.id);
      }
    }

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
            {sorted[0]?.display_name} wins with {sorted[0]?.score} point{sorted[0]?.score !== 1 ? 's' : ''}!
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

          {readyCount <= VOTING_MODE_MAX_PLAYERS && readyCount >= 2 && (
            <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg px-4 py-2.5 text-blue-300 text-sm mb-4">
              <Users className="w-4 h-4 inline mr-1.5" />
              Small game mode: everyone votes for the best answer
            </div>
          )}

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
                    <span className="text-green-400 text-sm flex items-center gap-1"><Check className="w-4 h-4" /> Ready</span>
                  ) : (
                    <span className="text-gray-500 text-sm">Not ready</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {user?.id === game.created_by && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-4 space-y-3">
              <p className="text-white font-bold text-sm">Game Modes</p>
              {([
                { key: 'ghost_card_enabled', label: '👻 Ghost Card', desc: '~15% chance per round a random player gets an auto-played card. If it wins: +3 points.' },
                { key: 'democratic_mode', label: '🗳️ Democratic Mode', desc: 'No Card Czar — everyone votes anonymously. Most votes wins.' },
                { key: 'rando_enabled', label: '🎲 Rando Cardrissian', desc: 'Every round adds an auto-played fake submission. If Rando wins, everyone loses a point.' },
                { key: 'hot_take_enabled', label: '🔥 Hot Take', desc: 'After winner is picked, all submissions are revealed with author names.' },
                { key: 'meritocracy_enabled', label: '👑 Meritocracy', desc: 'Last round\'s winner becomes the next Card Czar (czar mode only).' },
                { key: 'speed_round', label: '⚡ Speed Round', desc: '90-second timer instead of 2 minutes.' },
              ] as const).map(({ key, label, desc }) => (
                <label key={key} className="flex items-start justify-between cursor-pointer">
                  <div className="pr-3">
                    <div className="text-white font-medium text-sm">{label}</div>
                    <div className="text-gray-500 text-xs mt-0.5">{desc}</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={(game[key] as boolean) ?? false}
                    onChange={async (e) => {
                      await supabase.from('games').update({ [key]: e.target.checked }).eq('id', gameId);
                    }}
                    className="w-5 h-5 accent-red-500 mt-0.5 flex-shrink-0"
                  />
                </label>
              ))}
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={toggleReady}
              className={`flex-1 font-bold py-3 rounded-lg transition-colors ${
                myPlayer?.is_ready ? 'bg-gray-700 hover:bg-gray-600 text-gray-300' : 'bg-green-600 hover:bg-green-700 text-white'
              }`}
            >
              {myPlayer?.is_ready ? 'Unready' : 'Ready Up'}
            </button>
            {readyCount >= 2 && (
              <button onClick={startGame} className="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-lg transition-colors flex items-center justify-center gap-2">
                <Skull className="w-5 h-5" /> Start Game ({readyCount} ready)
              </button>
            )}
          </div>

          <button onClick={leaveGame} className="w-full mt-3 text-gray-500 hover:text-red-400 text-sm py-2 transition-colors">
            Leave Game
          </button>
        </div>
      </div>
    );
  }

  const roundStatus = currentRound?.status ?? 'submitting';
  const winnerSubmissions = submissions.filter((s) => s.is_winner);
  const isTie = winnerSubmissions.length > 1;

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
            {[...players].sort((a, b) => b.score - a.score).slice(0, 3).map((p) => (
              <span key={p.id} className="text-xs bg-gray-800 text-gray-300 px-2 py-1 rounded flex items-center gap-1">
                {!isVotingMode && p.is_czar && <Crown className="w-3 h-3 text-yellow-400" />}
                {p.display_name}: {p.score}
              </span>
            ))}
            {canSummonRando && (
              <button
                onClick={summonRando}
                className="text-xs text-gray-700 hover:text-gray-500 px-1.5 py-1 rounded transition-colors"
                title="✦"
                aria-label="✦"
              >
                ✦
              </button>
            )}
            <button
              onClick={leaveGame}
              className="text-xs text-gray-500 hover:text-red-400 px-2 py-1 rounded hover:bg-gray-800 transition-colors"
              title="Leave game"
            >
              Leave
            </button>
          </div>
        </div>

        {/* Black card */}
        {currentRound && (
          <div className="bg-black border-2 border-gray-700 rounded-xl p-6 mb-6">
            <p className="text-white text-xl md:text-2xl font-bold leading-relaxed">
              {currentRound.black_card.text}
            </p>
            {currentRound.black_card.text_es && (
              <p className="text-gray-400 mt-1.5" style={{ fontSize: '0.9rem' }}>
                ({currentRound.black_card.text_es})
              </p>
            )}
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
            {myPlayer?.has_submitted ? (
              submissions.find((s) => s.user_id === user?.id)?.is_ghost ? (
                <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg p-4 text-purple-200 text-center">
                  <div className="text-2xl mb-1">👻</div>
                  <div className="font-bold">The Ghost picked for you!</div>
                  <div className="text-sm text-purple-300/70 mt-1">
                    Your card is hidden until the reveal. If it wins, you score <span className="font-bold">+3</span>.
                  </div>
                  <div className="text-xs text-purple-300/60 mt-2">
                    {submissions.length}/{isVotingMode ? players.length : players.filter((p) => !p.is_czar).length} submitted
                  </div>
                </div>
              ) : (
                <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4 text-green-300 text-center">
                  <Check className="w-6 h-6 mx-auto mb-1" />
                  Cards submitted! Waiting for others...
                  <div className="text-sm text-green-400/70 mt-1">
                    {submissions.length}/{isVotingMode ? players.length : players.filter((p) => !p.is_czar).length} submitted
                  </div>
                </div>
              )
            ) : (
              <p className="text-gray-400 text-sm mb-2">
                Select {currentRound?.black_card.pick} card{currentRound?.black_card.pick !== 1 ? 's' : ''} from your hand:
              </p>
            )}
          </div>
        )}

        {roundStatus === 'judging' && (
          <div className="mb-6">
            {isVotingMode ? (
              <>
                <p className="text-gray-300 font-medium mb-3">
                  {hasVoted ? 'Vote cast! Waiting for others...' : 'Vote for the best answer:'}
                </p>
                <div className="grid gap-3 md:grid-cols-2">
                  {submissions.map((sub) => {
                    const submitter = players.find((p) => p.user_id === sub.user_id);
                    const votedThis = myVotedSubmissionId === sub.id;
                    return (
                      <button
                        key={sub.id}
                        onClick={() => !hasVoted && castVote(sub.id)}
                        disabled={hasVoted}
                        className={`text-left bg-white rounded-xl p-4 transition-all ${
                          hasVoted
                            ? votedThis ? 'ring-2 ring-blue-500 cursor-default' : 'cursor-default opacity-70'
                            : 'hover:scale-[1.02] hover:shadow-lg cursor-pointer'
                        }`}
                      >
                        <p className="text-xs font-bold text-gray-400 mb-1.5 uppercase tracking-wide">
                          {sub.is_rando ? '🎲 Rando Cardrissian' : (game.hot_take_enabled ? (submitter?.display_name ?? 'Unknown') : 'Anonymous')}
                        </p>
                        {(sub.cards as WhiteCard[]).map((card, i) => (
                          <p key={i} className="text-gray-900 font-medium text-lg leading-snug">
                            <CardText card={card} />
                          </p>
                        ))}
                        {votedThis && (
                          <p className="text-blue-500 text-xs mt-2 font-medium flex items-center gap-1">
                            <ThumbsUp className="w-3 h-3" /> Your vote
                          </p>
                        )}
                        {(sub.voter_ids as string[]).length > 0 && (
                          <p className="text-gray-400 text-xs mt-1">
                            {(sub.voter_ids as string[]).length} vote{(sub.voter_ids as string[]).length !== 1 ? 's' : ''}
                          </p>
                        )}
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <>
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
                        <p key={i} className="text-gray-900 font-medium text-lg leading-snug">
                          <CardText card={card} />
                        </p>
                      ))}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {roundStatus === 'finished' && (
          <div className="mb-6">
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-6 text-center mb-4">
              <Trophy className="w-8 h-8 text-yellow-400 mx-auto mb-2" />
              {isTie ? (
                <p className="text-yellow-300 font-bold text-lg">
                  Tie! {winnerSubmissions.map((s) => s.is_rando ? '🎲 Rando' : players.find((p) => p.user_id === s.user_id)?.display_name).join(' & ')} each get 0.5 pts
                </p>
              ) : winnerSubmissions[0]?.is_rando ? (
                <p className="text-red-300 font-bold text-lg">
                  🎲 Rando Cardrissian wins! Everyone loses a point.
                </p>
              ) : (
                <p className="text-yellow-300 font-bold text-lg">
                  {players.find((p) => p.user_id === winnerSubmissions[0]?.user_id)?.display_name} wins this round!
                  {winnerSubmissions[0]?.is_ghost && <span className="ml-2 text-purple-300">👻 +3 ghost bonus!</span>}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2 justify-center">
                {winnerSubmissions.map((s) => (
                  <div key={s.id} className="bg-white rounded-lg p-3 inline-block text-left">
                    {(s.cards as WhiteCard[]).map((card, i) => (
                      <p key={i} className="text-gray-900 font-bold">
                        <CardText card={card} />
                      </p>
                    ))}
                  </div>
                ))}
              </div>
            </div>
            {game.hot_take_enabled && submissions.length > 0 && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-4">
                <p className="text-orange-300 font-bold text-sm mb-3 flex items-center gap-1.5">🔥 Hot Take Reveal</p>
                <div className="space-y-2">
                  {submissions.map((sub) => {
                    const submitter = players.find((p) => p.user_id === sub.user_id);
                    const author = sub.is_rando ? '🎲 Rando Cardrissian' : sub.is_ghost ? `👻 ${submitter?.display_name ?? '?'} (Ghost)` : (submitter?.display_name ?? 'Unknown');
                    return (
                      <div key={sub.id} className={`bg-white rounded-lg p-3 ${sub.is_winner ? 'ring-2 ring-yellow-400' : ''}`}>
                        <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">{author}{sub.is_winner && ' — winner'}</p>
                        {(sub.cards as WhiteCard[]).map((card, i) => (
                          <p key={i} className="text-gray-900 font-medium">
                            <CardText card={card} />
                          </p>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {user?.id === game.created_by ? (
              <button onClick={nextRound} className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-lg transition-colors">
                Next Round
              </button>
            ) : (
              <p className="text-gray-500 text-sm text-center py-3">Waiting for host to start the next round…</p>
            )}
          </div>
        )}

        {/* Hand */}
        {roundStatus === 'submitting' && !myPlayer?.has_submitted && myPlayer && (
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
                      isSelected ? 'ring-2 ring-red-500 shadow-lg shadow-red-500/20 scale-[1.03]' : 'hover:shadow-md'
                    }`}
                  >
                    <p className="text-gray-900 font-medium text-sm leading-tight">
                      {card.text}
                      {card.text_es && (
                        <span className="block mt-1 text-gray-400" style={{ fontSize: '0.75rem' }}>({card.text_es})</span>
                      )}
                    </p>
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
      if (diff <= 0) { setTimeLeft('0:00'); return; }
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
