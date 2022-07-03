import { PLAN_PERIOD } from './../../../../constants/gallery/index';
import { PeriodToggler } from './periodToggler';
import React, { useContext, useEffect, useMemo, useState } from 'react';
import constants from 'utils/strings/constants';
import { Plan } from 'types/billing';
import {
    isUserSubscribedPlan,
    isSubscriptionCancelled,
    updateSubscription,
    hasStripeSubscription,
    isOnFreePlan,
    planForSubscription,
    hasMobileSubscription,
    hasPaypalSubscription,
    getLocalUserSubscription,
    hasPaidSubscription,
    convertBytesToGBs,
    getTotalFamilyUsage,
    makeHumanReadableStorage,
} from 'utils/billing';
import { reverseString } from 'utils/common';
import { GalleryContext } from 'pages/gallery';
import billingService from 'services/billingService';
import { SetLoading } from 'types/gallery';
import { logError } from 'utils/sentry';
import { AppContext } from 'pages/_app';
import Plans from './plans';
import { Box, IconButton, Stack, Typography } from '@mui/material';
import { useLocalState } from 'hooks/useLocalState';
import { LS_KEYS } from 'utils/storage/localStorage';
import { getLocalUserDetails } from 'utils/user';
import { ManageSubscription } from './manageSubscription';
import { SpaceBetweenFlex } from 'components/Container';
import Close from '@mui/icons-material/Close';

interface Props {
    closeModal: any;
    setLoading: SetLoading;
}

function PlanSelectorCard(props: Props) {
    const subscription = useMemo(() => getLocalUserSubscription(), []);
    const [plans, setPlans] = useLocalState<Plan[]>(LS_KEYS.PLANS);
    const [planPeriod, setPlanPeriod] = useState<PLAN_PERIOD>(PLAN_PERIOD.YEAR);
    const galleryContext = useContext(GalleryContext);
    const appContext = useContext(AppContext);

    const totalFamilyUsage = useMemo(() => {
        const familyData = getLocalUserDetails()?.familyData;
        return familyData ? getTotalFamilyUsage(familyData) : 0;
    }, []);

    const togglePeriod = () => {
        setPlanPeriod((prevPeriod) =>
            prevPeriod === PLAN_PERIOD.MONTH
                ? PLAN_PERIOD.YEAR
                : PLAN_PERIOD.MONTH
        );
    };
    function onReopenClick() {
        appContext.closeMessageDialog();
        galleryContext.showPlanSelectorModal();
    }
    useEffect(() => {
        const main = async () => {
            try {
                props.setLoading(true);
                let plans = await billingService.getPlans();

                const planNotListed =
                    plans.filter((plan) =>
                        isUserSubscribedPlan(plan, subscription)
                    ).length === 0;
                if (
                    subscription &&
                    !isOnFreePlan(subscription) &&
                    planNotListed
                ) {
                    plans = [planForSubscription(subscription), ...plans];
                }
                setPlans(plans);
            } catch (e) {
                logError(e, 'plan selector modal open failed');
                props.closeModal();
                appContext.setDialogMessage({
                    title: constants.OPEN_PLAN_SELECTOR_MODAL_FAILED,
                    content: constants.UNKNOWN_ERROR,
                    close: { text: 'close', variant: 'danger' },
                    proceed: {
                        text: constants.REOPEN_PLAN_SELECTOR_MODAL,
                        variant: 'accent',
                        action: onReopenClick,
                    },
                });
            } finally {
                props.setLoading(false);
            }
        };
        main();
    }, []);

    async function onPlanSelect(plan: Plan) {
        if (
            hasMobileSubscription(subscription) &&
            !isSubscriptionCancelled(subscription)
        ) {
            appContext.setDialogMessage({
                title: constants.ERROR,
                content: constants.CANCEL_SUBSCRIPTION_ON_MOBILE,
                close: { variant: 'danger' },
            });
        } else if (
            hasPaypalSubscription(subscription) &&
            !isSubscriptionCancelled(subscription)
        ) {
            appContext.setDialogMessage({
                title: constants.MANAGE_PLAN,
                content: constants.PAYPAL_MANAGE_NOT_SUPPORTED_MESSAGE(),
                close: { variant: 'danger' },
            });
        } else if (hasStripeSubscription(subscription)) {
            appContext.setDialogMessage({
                title: `${constants.CONFIRM} ${reverseString(
                    constants.UPDATE_SUBSCRIPTION
                )}`,
                content: constants.UPDATE_SUBSCRIPTION_MESSAGE,
                proceed: {
                    text: constants.UPDATE_SUBSCRIPTION,
                    action: updateSubscription.bind(
                        null,
                        plan,
                        appContext.setDialogMessage,
                        props.setLoading,
                        props.closeModal
                    ),
                    variant: 'accent',
                },
                close: { text: constants.CANCEL },
            });
        } else {
            try {
                props.setLoading(true);
                await billingService.buySubscription(plan.stripeID);
            } catch (e) {
                props.setLoading(false);
                appContext.setDialogMessage({
                    title: constants.ERROR,
                    content: constants.SUBSCRIPTION_PURCHASE_FAILED,
                    close: { variant: 'danger' },
                });
            }
        }
    }

    return (
        <>
            <Stack spacing={3} p={1.5}>
                <Box py={0.5} px={1.5}>
                    {hasPaidSubscription(subscription) ? (
                        <SpaceBetweenFlex>
                            <Box>
                                <Typography variant="h3" fontWeight={'bold'}>
                                    {constants.SUBSCRIPTION}
                                </Typography>
                                <Typography
                                    variant="body2"
                                    color={'text.secondary'}>
                                    {convertBytesToGBs(subscription.storage)}{' '}
                                    {constants.GB}
                                </Typography>
                            </Box>
                            <IconButton onClick={props.closeModal}>
                                <Close />
                            </IconButton>
                        </SpaceBetweenFlex>
                    ) : (
                        <Typography variant="h3" fontWeight={'bold'}>
                            {constants.CHOOSE_PLAN}
                        </Typography>
                    )}
                </Box>
                {totalFamilyUsage > 0 && (
                    <Box px={1.5}>
                        <Typography
                            color={'text.secondary'}
                            fontWeight={'bold'}>
                            {constants.CURRENT_USAGE(
                                makeHumanReadableStorage(totalFamilyUsage)
                            )}
                        </Typography>
                    </Box>
                )}
                <Box>
                    <Stack
                        spacing={3}
                        border={(theme) =>
                            hasPaidSubscription(subscription) &&
                            `1px solid ${theme.palette.divider}`
                        }
                        p={1.5}
                        borderRadius={(theme) =>
                            `${theme.shape.borderRadius}px`
                        }>
                        <Box>
                            <PeriodToggler
                                planPeriod={planPeriod}
                                togglePeriod={togglePeriod}
                            />
                            <Typography mt={0.5} color="text.secondary">
                                {constants.TWO_MONTHS_FREE}
                            </Typography>
                        </Box>
                        <Plans
                            plans={plans}
                            planPeriod={planPeriod}
                            onPlanSelect={onPlanSelect}
                            subscription={subscription}
                        />
                    </Stack>
                    {hasPaidSubscription(subscription) && (
                        <Box py={1} px={1.5}>
                            <Typography color={'text.secondary'}>
                                {constants.RENEWAL_ACTIVE_SUBSCRIPTION_INFO(
                                    subscription.expiryTime
                                )}
                            </Typography>
                        </Box>
                    )}
                </Box>
                {hasPaidSubscription(subscription) && (
                    <ManageSubscription
                        subscription={subscription}
                        closeModal={props.closeModal}
                        setLoading={props.setLoading}
                    />
                )}
            </Stack>
        </>
    );
}

export default PlanSelectorCard;
