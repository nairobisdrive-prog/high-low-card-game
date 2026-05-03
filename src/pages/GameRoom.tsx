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
