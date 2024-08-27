import { useMediaQuery, useTheme } from "@mui/material";

/**
 * Return true if the screen width is classified as a "mobile" size.
 *
 * We use the MUI "sm" (small, 600px) breakpoint as the cutoff. This hook will
 * return true if the size of the window's width is less than 600px.
 */
export const useIsMobileWidth = () =>
    useMediaQuery(useTheme().breakpoints.down("sm"));

/**
 * Heuristic "isMobileOrTablet" check using a pointer media query.
 *
 * The absence of fine-resolution pointing device can be taken a quick and proxy
 * for detecting if the user is using a mobile or tablet.
 *
 * This is of course not going to work in all scenarios (e.g. someone connecting
 * their mice to their tablet), but ad-hoc user agent checks are not problem
 * free either. This media query should be accurate enough for cases where false
 * positives will degrade gracefully.
 *
 * See: https://github.com/mui/mui-x/issues/10039
 */
export const useIsTouchscreen = () =>
    useMediaQuery("(hover: none) and (pointer: coarse)", { noSsr: true });
