/**
 * The voice sheet's orb and its library, as their own download: fetched when the voice sheet
 * first opens (or when the dock's mic is first touched), never by screens that don't open voice.
 */
export const loadVoiceOrb = () => import('@/components/shiftsync/VoiceOrb');
